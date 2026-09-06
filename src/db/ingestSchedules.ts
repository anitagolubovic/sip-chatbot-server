import "dotenv/config";
import { readdirSync } from "fs";
import path from "path";
import { withTransaction } from "./pool";
import {
  combinedHash,
  insertRows,
  isUnchanged,
  parseIngestArguments,
  readSourceFile,
  recordSourceFile,
  runIngestCli,
  type IngestOptions,
  type SourceFile,
} from "./ingestRuntime";
import { toSearchForm } from "../preprocessing";
import type { ClassScheduleDocument } from "../models/classSchedule";
import { currentAcademicYear, dataFile } from "../scraper/lib/scraperRuntime";
import { Maybe } from "../models/types";
import { isDefined, isNotDefined } from "../helper";

const SCHEDULES_DIR = dataFile("raspored-casova");
const INDEX_FILE = "index.json";

const ENTRY_COLUMNS = [
  "schedule_id",
  "day",
  "starts_at",
  "ends_at",
  "class_type",
  "course",
  "course_norm",
  "groups",
  "room",
  "rooms_by_group",
  "from_ocr",
  "ocr_confidence",
  "raw_text",
] as const;

const INDEX_GROUP_COLUMNS = [
  "academic_year",
  "source_url",
  "index_from",
  "index_to",
  "lecture_group",
  "exercise_group",
] as const;

export async function ingestSchedules(
  requestedYear?: string,
  options: IngestOptions = {},
): Promise<void> {
  const academicYear = requestedYear ?? currentAcademicYear();
  const sources = loadSchedules(academicYear);

  if (sources.length === 0) {
    throw new Error(
      `No class schedules for ${academicYear} in ${SCHEDULES_DIR}. ` +
        'Run "npm run update:raspored-casova" first.',
    );
  }

  const sourcePath = `raspored-casova/*-${academicYear.replace("/", "-")}.json`;
  const contentHash = combinedHash(sources.map((item) => item.contentHash));

  if (
    isDefined(options.force) &&
    options.force &&
    (await isUnchanged(sourcePath, contentHash))
  ) {
    console.log(`${sourcePath} is unchanged since the last ingest, skipping.`);
    return;
  }

  let entryCount = 0;
  let indexGroupCount = 0;

  await withTransaction(async (client) => {
    await client.query("DELETE FROM schedules WHERE academic_year = $1", [
      academicYear,
    ]);
    await client.query("DELETE FROM index_groups WHERE academic_year = $1", [
      academicYear,
    ]);

    for (const { path: file, document } of sources) {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO schedules
           (file, academic_year, study_level, semester, study_year,
            semester_type, module, submodule, module_label, page_url,
            pdf_url, pdf_sha256, group_rooms, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          file,
          academicYear,
          document.studyLevel,
          document.semester,
          document.studyYear,
          document.semesterType,
          document.module,
          document.submodule,
          document.moduleLabel,
          document.source.pageUrl,
          document.source.pdfUrl,
          document.source.pdfSha256,
          JSON.stringify(document.groupRooms ?? {}),
          JSON.stringify(document),
        ],
      );

      const scheduleId = inserted.rows[0].id;
      const entries = document.schedule.map((entry) => [
        scheduleId,
        entry.day,
        entry.startsAt,
        entry.endsAt,
        entry.classType,
        entry.course,
        toSearchForm(entry.course),
        splitGroups(entry.group),
        entry.room,
        "{}",
        entry.fromOcr,
        entry.ocrConfidence ?? null,
        entry.rawText,
      ]);

      await insertRows(client, "schedule_entries", ENTRY_COLUMNS, entries);
      entryCount += entries.length;

      const ranges = document.indexGroups?.ranges ?? [];
      if (ranges.length > 0) {
        for (const range of ranges) {
          const stored = await client.query(
            `INSERT INTO index_groups
               (academic_year, source_url, index_from, index_to,
                lecture_group, exercise_group)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (academic_year, index_from, index_to) DO NOTHING`,
            [
              academicYear,
              document.indexGroups?.sourceUrl ?? null,
              range.indexFrom,
              range.indexTo,
              range.lectureGroup,
              range.exerciseGroup,
            ],
          );
          indexGroupCount += stored.rowCount ?? 0;
        }
      }
    }

    await recordSourceFile(client, sourcePath, contentHash, sources.length);

    console.log(
      `${academicYear}: inserted ${sources.length} schedules, ` +
        `${entryCount} entries, ${indexGroupCount} index group ranges.`,
    );
  });
}

if (require.main === module) {
  const { academicYear, options } = parseIngestArguments(process.argv.slice(2));
  runIngestCli(
    () => ingestSchedules(academicYear, options),
    "Class schedule ingest failed:",
  );
}

function loadSchedules(
  academicYear: string,
): SourceFile<ClassScheduleDocument>[] {
  return readdirSync(SCHEDULES_DIR)
    .filter((name) => name.endsWith(".json") && name !== INDEX_FILE)
    .sort()
    .map((name) =>
      readSourceFile<ClassScheduleDocument>(path.join(SCHEDULES_DIR, name)),
    )
    .filter((source) => source.document.academicYear === academicYear);
}

function splitGroups(group: Maybe<string>): string[] {
  if (isNotDefined(group)) {
    return [];
  }

  return group
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
