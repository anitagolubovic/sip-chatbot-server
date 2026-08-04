import * as cheerio from "cheerio";
import { PDFParse } from "pdf-parse";
import { fetchHtml, fetchPdf, SITE_ORIGIN } from "./lib/httpClient";
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
  ExamScheduleDocument,
  RokResult,
} from "../models/examSchedule";

function sourceUrlFor(academicYear: string): string {
  return `${SITE_ORIGIN}/article/polaganje-ispita/rasporedi-ispita-${academicYearSlug(academicYear)}`;
}

const STUDY_LEVEL_BY_LABEL: { [label: string]: string } = {
  oas: "osnovne_akademske",
  mas: "master_akademske",
};

const LEVEL = "ОАС|МАС|OAS|MAS";
const DAY_NAMES =
  "понедељак|уторак|среда|четвртак|петак|субота|недеља|" +
  "ponedeljak|utorak|sreda|cetvrtak|petak|subota|nedelja|" +
  "četvrtak|nedjelja";

const EXAM_ROW_REGEX = new RegExp(
  `^(?:\\d+\\s+)?(${LEVEL})\\s+(\\d{4})\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(.+?)\\s+` +
    `((?:${DAY_NAMES}),\\s*\\d{1,2}\\.\\s*\\S+\\s*\\d{4}\\.)\\s*` +
    `(\\d{1,2}:\\d{2}(?::\\d{2})?)?\\s*$`,
  "iu",
);

function parseTime(rawTime?: string): string | null {
  if (!rawTime) {
    return null;
  }
  const [hours, minutes] = rawTime.split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
}

async function fetchExamPeriodLinks(sourceUrl: string): Promise<PdfLink[]> {
  return pdfLinks(cheerio.load(await fetchHtml(sourceUrl)));
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
      studyLevel:
        STUDY_LEVEL_BY_LABEL[latinSearchText(levelLabel)] || levelLabel,
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

async function parsePdf(pdfUrl: string): Promise<ExamEntry[]> {
  const buffer = await fetchPdf(pdfUrl);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return parseExamRows(result.text);
}

export async function scrapeExamSchedule(
  requestedYear?: string,
): Promise<void> {
  const academicYear = requireAcademicYear(requestedYear, "update:exams");
  const sourceUrl = sourceUrlFor(academicYear);

  console.log(`Preuzimam spisak rokova sa: ${sourceUrl}`);
  const links = await fetchExamPeriodLinks(sourceUrl);

  if (links.length === 0) {
    throw new Error(
      "Nije pronadjen nijedan PDF link na stranici - proveriti da li se struktura stranice promenila.",
    );
  }

  console.log(`Pronadjeno rokova: ${links.length}`);

  const rokovi: RokResult[] = [];
  for (const { label, url } of links) {
    console.log(`Obradjujem rok "${label}" (${url})...`);
    const exams = await parsePdf(url);
    console.log(`  -> izvuceno ${exams.length} ispita`);
    rokovi.push({ rok: slugify(label), label, pdfUrl: url, exams });
  }

  const output: ExamScheduleDocument = {
    schemaVersion: 1,
    category: "polaganje_ispita",
    language: "sr",
    academicYear,
    sourceUrl,
    generatedAt: new Date().toISOString(),
    rokovi,
  };

  const destination = dataFile(
    `polaganje-ispita-${academicYearSlug(academicYear)}.json`,
  );
  writeJson(destination, output);
  console.log(`Sacuvano u: ${destination}`);
}

if (require.main === module) {
  runCli(
    () => scrapeExamSchedule(process.argv[2]),
    "Greska prilikom scrape-ovanja rasporeda ispita:",
  );
}
