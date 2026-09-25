import "dotenv/config";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import path from "path";
import type { PoolClient } from "pg";
import { closePool, query, withTransaction } from "./pool";
import { isDefined } from "../helper";
import { canonicalCourseNames, toSearchForm } from "../preprocessing";
import type {
  ExamScheduleDocument,
  ExamSlot,
  ExamSlotsDocument,
} from "../models/examSchedule";
import { latinSearchText } from "../scraper/lib/textNormalization";
import {
  academicYearSlug,
  currentAcademicYear,
  DATA_DIR,
  dataFile,
} from "../scraper/lib/scraperRuntime";
import { Maybe } from "../models/types";

const COLUMNS = [
  "academic_year",
  "exam_period",
  "exam_period_label",
  "pdf_url",
  "study_level",
  "accreditation",
  "semester",
  "module",
  "course_code",
  "course_name",
  "course_name_norm",
  "exam_date",
  "exam_time",
  "duration_minutes",
  "rooms",
  "slot_url",
] as const;

const ROWS_PER_BATCH = Math.floor(65535 / COLUMNS.length / 2);

type ExamRow = Maybe<string | number>[];

type SlotSource = ExamSlot & { url: string };

function readDocument(file: string): {
  document: ExamScheduleDocument;
  contentHash: string;
} {
  const raw = readFileSync(file, "utf8");
  const document = JSON.parse(raw) as ExamScheduleDocument;

  if (document.category !== "polaganje_ispita") {
    throw new Error(
      `${file} is not an exam schedule document (category: "${document.category}").`,
    );
  }
  if (
    !Array.isArray(document.examPeriods) ||
    document.examPeriods.length === 0
  ) {
    throw new Error(
      `${file} contains no exam periods. Run "npm run update:exams" first.`,
    );
  }

  return {
    document,
    contentHash: createHash("sha256").update(raw).digest("hex"),
  };
}

function readSlots(
  file: string,
): Maybe<{ document: ExamSlotsDocument; contentHash: string }> {
  // Satnica se objavljuje tek pred rok, pa raspored mora da se upise i bez nje.
  if (!existsSync(file)) return null;

  const raw = readFileSync(file, "utf8");
  const document = JSON.parse(raw) as ExamSlotsDocument;

  if (document.category !== "satnica_ispita") {
    throw new Error(
      `${file} is not an exam slots document (category: "${document.category}").`,
    );
  }

  return {
    document,
    contentHash: createHash("sha256").update(raw).digest("hex"),
  };
}

// Ista sifra je u satnici nekad latinicom ("3OEZ1O05"), a u rasporedu
// cirilicom ("3ОЕЗ1О05"), pa se porede transliterovane.
function slotKey(examPeriod: string, courseCode: string): string {
  return `${examPeriod}|${latinSearchText(courseCode).replace(/\s+/g, "")}`;
}

function slotsByKey(
  document: Maybe<ExamSlotsDocument>,
): Map<string, SlotSource> {
  const slots = new Map<string, SlotSource>();
  // Stranice su poredjane po objavi, pa izmena satnice pregazi original.
  for (const page of document?.pages ?? []) {
    for (const slot of page.slots) {
      slots.set(slotKey(page.examPeriod, slot.courseCode), {
        ...slot,
        url: page.url,
      });
    }
  }
  return slots;
}

function buildRows(
  document: ExamScheduleDocument,
  slots: Map<string, SlotSource>,
): {
  rows: ExamRow[];
  renamed: number;
  withSlot: number;
  movedDates: number;
  unmatchedSlots: number;
} {
  const canonical = canonicalCourseNames(
    document.examPeriods.flatMap((period) =>
      period.exams.map((exam) => exam.courseName),
    ),
  );
  let renamed = 0;
  let withSlot = 0;
  let movedDates = 0;
  const usedSlots = new Set<string>();

  const rows = document.examPeriods.flatMap((period) =>
    period.exams.map((exam): ExamRow => {
      const courseName = canonical.get(exam.courseName) ?? exam.courseName;
      if (courseName !== exam.courseName) renamed += 1;

      const key = slotKey(period.name, exam.courseCode);
      const slot = slots.get(key);
      if (slot) {
        usedSlots.add(key);
        withSlot += 1;
        if (slot.date && exam.date && slot.date !== exam.date) movedDates += 1;
      }

      // Satnica je objavljena posle rasporeda, pa njen datum i vreme imaju prednost.
      return [
        document.academicYear,
        period.name,
        period.label,
        period.pdfUrl,
        exam.studyLevel,
        exam.accreditation,
        exam.semester,
        exam.module,
        exam.courseCode,
        courseName,
        toSearchForm(courseName),
        slot?.date ?? exam.date ?? null,
        slot?.time ?? exam.time ?? null,
        slot?.durationMinutes ?? null,
        slot?.rooms ?? null,
        slot?.url ?? null,
      ];
    }),
  );

  return {
    rows,
    renamed,
    withSlot,
    movedDates,
    unmatchedSlots: slots.size - usedSlots.size,
  };
}

async function recordSource(
  client: PoolClient,
  sourcePath: string,
  contentHash: string,
  recordCount: number,
): Promise<void> {
  await client.query(
    `INSERT INTO source_files (path, sha256, record_count, ingested_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (path) DO UPDATE
       SET sha256 = EXCLUDED.sha256,
           record_count = EXCLUDED.record_count,
           ingested_at = EXCLUDED.ingested_at`,
    [sourcePath, contentHash, recordCount],
  );
}

async function insertRows(client: PoolClient, rows: ExamRow[]): Promise<void> {
  for (let start = 0; start < rows.length; start += ROWS_PER_BATCH) {
    const batch = rows.slice(start, start + ROWS_PER_BATCH);
    const values = batch
      .map(
        (_, rowIndex) =>
          `(${COLUMNS.map(
            (_column, columnIndex) =>
              `$${rowIndex * COLUMNS.length + columnIndex + 1}`,
          ).join(", ")})`,
      )
      .join(", ");

    await client.query(
      `INSERT INTO exams (${COLUMNS.join(", ")}) VALUES ${values}`,
      batch.flat(),
    );
  }
}

export async function ingestExams(
  requestedYear?: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const academicYear = requestedYear ?? currentAcademicYear();
  const file = dataFile(
    `polaganje-ispita-${academicYearSlug(academicYear)}.json`,
  );
  const slotsFile = dataFile(
    `satnica-ispita-${academicYearSlug(academicYear)}.json`,
  );
  const sourcePath = path.relative(DATA_DIR, file).replace(/\\/g, "/");
  const slotsPath = path.relative(DATA_DIR, slotsFile).replace(/\\/g, "/");

  const { document, contentHash } = readDocument(file);
  const slotsSource = readSlots(slotsFile);

  const previous = new Map(
    (
      await query<{ path: string; sha256: string }>(
        "SELECT path, sha256 FROM source_files WHERE path = ANY($1)",
        [[sourcePath, slotsPath]],
      )
    ).map((row) => [row.path, row.sha256]),
  );

  // Satnica menja iste redove kao raspored, pa se ponovo upisuje kad se
  // promeni bilo koji od ta dva fajla.
  if (
    !options.force &&
    previous.get(sourcePath) === contentHash &&
    previous.get(slotsPath) === slotsSource?.contentHash
  ) {
    console.log(
      `${sourcePath} and ${slotsPath} are unchanged since the last ingest, skipping.`,
    );
    return;
  }

  const slots = slotsByKey(slotsSource?.document ?? null);
  const { rows, renamed, withSlot, movedDates, unmatchedSlots } = buildRows(
    document,
    slots,
  );

  await withTransaction(async (client) => {
    const deleted = await client.query(
      "DELETE FROM exams WHERE academic_year = $1",
      [academicYear],
    );
    await insertRows(client, rows);
    await recordSource(client, sourcePath, contentHash, rows.length);
    if (isDefined(slotsSource)) {
      await recordSource(client, slotsPath, slotsSource.contentHash, slots.size);
    } else {
      await client.query("DELETE FROM source_files WHERE path = $1", [
        slotsPath,
      ]);
    }

    console.log(
      `${academicYear}: removed ${deleted.rowCount ?? 0}, inserted ${rows.length} exams ` +
        `from ${document.examPeriods.length} exam periods ` +
        `(${renamed} course names unified, ${withSlot} with rooms from the exam slots, ` +
        `${movedDates} dates corrected by them, ${unmatchedSlots} slots without a matching exam).`,
    );
  });
}

if (require.main === module) {
  const [yearArgument] = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--"));
  ingestExams(yearArgument, { force: process.argv.includes("--force") })
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (error: unknown) => {
      console.error(
        "Exam ingest failed:",
        error instanceof Error ? error.message : error,
      );
      await closePool();
      process.exit(1);
    });
}
