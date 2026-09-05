import "dotenv/config";
import { withTransaction } from "./pool";
import {
  insertRows,
  isUnchanged,
  parseIngestArguments,
  readSourceFile,
  recordSourceFile,
  runIngestCli,
  type IngestOptions,
} from "./ingestRuntime";
import type { ActivityCalendarDocument, Calendar } from "../models/calendar";
import {
  academicYearSlug,
  currentAcademicYear,
  dataFile,
} from "../scraper/lib/scraperRuntime";

const DAY_COLUMNS = ["level_id", "kind", "day", "note", "raw"] as const;

const EXAM_PERIOD_COLUMNS = [
  "level_id",
  "name",
  "label",
  "held_from",
  "held_to",
  "held_raw",
  "apply_from",
  "apply_to",
  "apply_raw",
] as const;

type Counts = { levels: number; examPeriods: number; days: number };

function dayRows(levelId: number, level: Calendar): unknown[][] {
  // Jedan red po datumu: napomena u kalendaru zna da pokrije vise dana odjednom.
  return [
    ...level.workingDays.map((day) => ["radni", day] as const),
    ...level.nonWorkingDaysAndHolidays.map((day) => ["neradni", day] as const),
  ].flatMap(([kind, day]) =>
    day.dates.map((date) => [levelId, kind, date, day.note, day.raw]),
  );
}

export async function ingestCalendar(
  requestedYear?: string,
  options: IngestOptions = {},
): Promise<void> {
  const academicYear = requestedYear ?? currentAcademicYear();
  const source = readSourceFile<ActivityCalendarDocument>(
    dataFile(`kalendar-aktivnosti-${academicYearSlug(academicYear)}.json`),
  );

  if (source.document.category !== "kalendar_aktivnosti") {
    throw new Error(
      `${source.path} is not an activity calendar document (category: "${source.document.category}").`,
    );
  }
  if (source.document.levels.length === 0) {
    throw new Error(
      `${source.path} contains no study levels. Run "npm run update:kalendar" first.`,
    );
  }

  if (!options.force && (await isUnchanged(source.path, source.contentHash))) {
    console.log(`${source.path} is unchanged since the last ingest, skipping.`);
    return;
  }

  const counts: Counts = { levels: 0, examPeriods: 0, days: 0 };

  await withTransaction(async (client) => {
    // Brisanje nivoa kaskadno uklanja i rokove i dane tog nivoa.
    await client.query("DELETE FROM calendar_levels WHERE academic_year = $1", [
      academicYear,
    ]);

    for (const level of source.document.levels) {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO calendar_levels
           (academic_year, study_level, label, source_url, pdf_url,
            semesters, vacation, semester_validation, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          academicYear,
          level.studyLevel,
          level.label,
          level.sourceUrl,
          level.pdfUrl,
          JSON.stringify(level.semesters),
          level.vacation ? JSON.stringify(level.vacation) : null,
          level.semesterValidation,
          JSON.stringify(level),
        ],
      );

      const levelId = inserted.rows[0].id;
      counts.levels += 1;

      const periods = level.examPeriods.map((period) => [
        levelId,
        period.name,
        period.label,
        period.held.from,
        period.held.to,
        period.held.raw,
        period.examRegistration?.from ?? null,
        period.examRegistration?.to ?? null,
        period.examRegistration?.raw ?? null,
      ]);
      await insertRows(
        client,
        "calendar_exam_periods",
        EXAM_PERIOD_COLUMNS,
        periods,
      );
      counts.examPeriods += periods.length;

      const days = dayRows(levelId, level);
      await insertRows(client, "calendar_days", DAY_COLUMNS, days);
      counts.days += days.length;
    }

    await recordSourceFile(
      client,
      source.path,
      source.contentHash,
      counts.levels,
    );

    console.log(
      `${academicYear}: inserted ${counts.levels} calendar levels, ` +
        `${counts.examPeriods} exam periods, ${counts.days} marked days.`,
    );
  });
}

if (require.main === module) {
  const { academicYear, options } = parseIngestArguments(process.argv.slice(2));
  runIngestCli(
    () => ingestCalendar(academicYear, options),
    "Calendar ingest failed:",
  );
}
