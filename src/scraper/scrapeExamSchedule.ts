import * as cheerio from "cheerio";
import { fetchHtml, fetchPdf, SITE_ORIGIN } from "./lib/httpClient";
import { extractPdfText } from "./lib/pdfParseIsolated";
import { pdfLinks, type PdfLink } from "./lib/pdfLinks";
import { parseTextualDate } from "./lib/serbianDates";
import { latinSearchText, slugify } from "./lib/textNormalization";
import {
  academicYearSlug,
  dataFile,
  requireAcademicYear,
  runCli,
  writeJson,
} from "./lib/scraperRuntime";
import type {
  ExamEntry,
  ExamPeriodResult,
  ExamScheduleDocument,
} from "../models/examSchedule";
import { isNotDefined } from "../helper";
import { Maybe } from "../models/types";

const STUDY_LEVEL_BY_LABEL: { [label: string]: string } = {
  oas: "osnovne_akademske",
  mas: "master_akademske",
};

const LEVEL = "ОАС|МАС|OAS|MAS";
const DAY_NAMES: readonly string[] = [
  "понедељак",
  "уторак",
  "среда",
  "четвртак",
  "петак",
  "субота",
  "недеља",
  "ponedeljak",
  "utorak",
  "sreda",
  "cetvrtak",
  "petak",
  "subota",
  "nedelja",
];

const DAY_PATTERN = DAY_NAMES.join("|");

const EXAM_ROW_REGEX = new RegExp(
  `^(?:\\d+\\s+)?(${LEVEL})\\s+(\\d{4})\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(.+?)\\s+` +
    `((?:${DAY_PATTERN}),\\s*\\d{1,2}\\.\\s*\\S+\\s*\\d{4}\\.)\\s*` +
    `(\\d{1,2}:\\d{2}(?::\\d{2})?)?\\s*$`,
  "iu",
);

export async function scrapeExamSchedule(
  requestedYear?: string,
): Promise<void> {
  const academicYear = requireAcademicYear(requestedYear, "update:exams");
  const sourceUrl = sourceUrlFor(academicYear);

  const links = await fetchExamPeriodLinks(sourceUrl);

  if (links.length === 0) {
    throw new Error(
      "No exam period links found on the source page. The page format may have changed.",
    );
  }

  const examPeriods: ExamPeriodResult[] = [];
  for (const { label, url } of links) {
    const exams = await parsePdf(url);
    if (exams.length === 0) {
      throw new Error(
        `No exam rows recognized in "${label}" (${url}). ` +
          "The PDF format may have changed.",
      );
    }
    examPeriods.push({ name: slugify(label), label, pdfUrl: url, exams });
  }

  const output: ExamScheduleDocument = {
    schemaVersion: 1,
    category: "polaganje_ispita",
    language: "sr",
    academicYear,
    sourceUrl,
    generatedAt: new Date().toISOString(),
    examPeriods,
  };

  const destination = dataFile(
    `polaganje-ispita-${academicYearSlug(academicYear)}.json`,
  );
  writeJson(destination, output);
}

function sourceUrlFor(academicYear: string): string {
  return `${SITE_ORIGIN}/article/polaganje-ispita/rasporedi-ispita-${academicYearSlug(academicYear)}`;
}

async function fetchExamPeriodLinks(sourceUrl: string): Promise<PdfLink[]> {
  return pdfLinks(cheerio.load(await fetchHtml(sourceUrl)));
}

async function parsePdf(pdfUrl: string): Promise<ExamEntry[]> {
  const buffer = await fetchPdf(pdfUrl);
  const text = await extractPdfText(buffer);
  return parseExamRows(text);
}

function parseExamRows(pdfText: string): ExamEntry[] {
  const lines = pdfText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));

  const exams: ExamEntry[] = [];

  lines.forEach((line) => {
    const match = line.match(EXAM_ROW_REGEX);
    if (!match) {
      return;
    }
    const [
      ,
      levelLabel,
      accreditation,
      semester,
      module,
      courseCode,
      courseName,
      rawDate,
      rawTime,
    ] = match;

    exams.push({
      studyLevel: STUDY_LEVEL_BY_LABEL[latinSearchText(levelLabel)],
      accreditation,
      semester,
      module,
      courseCode,
      courseName: courseName.trim(),
      date: parseTextualDate(rawDate),
      time: parseTime(rawTime),
    });
  });

  return exams;
}

function parseTime(rawTime?: string): Maybe<string> {
  if (isNotDefined(rawTime)) {
    return null;
  }
  const [hours, minutes] = rawTime.split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
}

if (require.main === module) {
  runCli(
    () => scrapeExamSchedule(process.argv[2]),
    "Error while scraping exam schedule. The page format may have changed.",
  );
}
