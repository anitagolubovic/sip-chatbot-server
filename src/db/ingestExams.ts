import "dotenv/config";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type { PoolClient } from "pg";
import { closePool, query, withTransaction } from "./pool";
import { isDefined } from "../helper";
import { canonicalCourseNames, toSearchForm } from "../preprocessing";
import type { ExamScheduleDocument } from "../models/examSchedule";
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
] as const;

const ROWS_PER_BATCH = Math.floor(65535 / COLUMNS.length / 2);

type ExamRow = Maybe<string>[];

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

function buildRows(document: ExamScheduleDocument): {
  rows: ExamRow[];
  renamed: number;
} {
  const canonical = canonicalCourseNames(
    document.examPeriods.flatMap((period) =>
      period.exams.map((exam) => exam.courseName),
    ),
  );
  let renamed = 0;

  const rows = document.examPeriods.flatMap((period) =>
    period.exams.map((exam): ExamRow => {
      const courseName = canonical.get(exam.courseName) ?? exam.courseName;
      if (courseName !== exam.courseName) renamed += 1;

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
        exam.date ?? null,
        exam.time ?? null,
      ];
    }),
  );

  return { rows, renamed };
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
  const sourcePath = path.relative(DATA_DIR, file).replace(/\\/g, "/");

  const { document, contentHash } = readDocument(file);

  const [previous] = await query<{ sha256: string }>(
    "SELECT sha256 FROM source_files WHERE path = $1",
    [sourcePath],
  );

  if (
    !options.force &&
    isDefined(previous) &&
    previous.sha256 === contentHash
  ) {
    console.log(`${sourcePath} is unchanged since the last ingest, skipping.`);
    return;
  }

  const { rows, renamed } = buildRows(document);

  await withTransaction(async (client) => {
    const deleted = await client.query(
      "DELETE FROM exams WHERE academic_year = $1",
      [academicYear],
    );
    await insertRows(client, rows);
    await client.query(
      `INSERT INTO source_files (path, sha256, record_count, ingested_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (path) DO UPDATE
         SET sha256 = EXCLUDED.sha256,
             record_count = EXCLUDED.record_count,
             ingested_at = EXCLUDED.ingested_at`,
      [sourcePath, contentHash, rows.length],
    );

    console.log(
      `${academicYear}: removed ${deleted.rowCount ?? 0}, inserted ${rows.length} exams ` +
        `from ${document.examPeriods.length} exam periods ` +
        `(${renamed} course names unified).`,
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
