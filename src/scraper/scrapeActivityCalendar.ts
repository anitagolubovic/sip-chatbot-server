import * as cheerio from "cheerio";
import { fetchHtml, SITE_ORIGIN } from "./lib/httpClient";
import { pdfLinks } from "./lib/pdfLinks";
import { numericDatesIn } from "./lib/serbianDates";
import { cleanText, latinSearchText, slugify } from "./lib/textNormalization";
import {
  academicYearSlug,
  dataFile,
  requireAcademicYear,
  runCli,
  writeJson,
} from "./lib/scraperRuntime";
import type {
  ActivityCalendarDocument,
  Calendar,
  ExamPeriod,
  Period,
} from "../models/calendar";
import { Maybe } from "../models/types";

type Source = ReturnType<typeof sourcesFor>[number];

const RANGE =
  /\bod\s+(\d{1,2}\.\d{1,2}\.\d{4})\.\s*do\s+(\d{1,2}\.\d{1,2}\.\d{4})\./;

function noteInParens(line: string): string {
  return line.match(/\(([^)]+)\)/)?.[1].trim() ?? "";
}

const NOISE = "script, style, noscript, nav, header, footer, form";
const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt";

function findPdfUrl($: cheerio.CheerioAPI): Maybe<string> {
  return (
    pdfLinks($).find((link) => link.url.includes("kalendar-aktivnosti"))?.url ??
    null
  );
}

function parseCalendar(source: Source, $: cheerio.CheerioAPI): Calendar {
  const lines = toLines($);

  const calendar: Calendar = {
    studyLevel: source.studyLevel,
    label: source.label,
    sourceUrl: source.url,
    pdfUrl: findPdfUrl($),
    semesters: { autumn: null, spring: null },
    vacation: null,
    semesterValidation: null,
    workingDays: [],
    nonWorkingDaysAndHolidays: [],
    examPeriods: [],
    notes: [],
    rawText: lines.join("\n"),
  };

  let inHolidays = false;
  let examPeriod: Maybe<ExamPeriod> = null;

  for (const line of lines) {
    const n = latinSearchText(line);

    if (/jesenji semestar/.test(n) && /pocinje/.test(n)) {
      calendar.semesters.autumn = periodIn(line);
      continue;
    }

    if (/prolecni semestar/.test(n) && /pocinje/.test(n)) {
      calendar.semesters.spring = periodIn(line);
      continue;
    }

    if (/raspust/.test(n)) {
      calendar.vacation = periodIn(line);
      continue;
    }

    if (/^overa/.test(n)) {
      calendar.semesterValidation = line;
      continue;
    }

    if (/je radna/.test(n)) {
      inHolidays = false;
      calendar.workingDays.push({
        dates: numericDatesIn(line),
        note: noteInParens(line),
        raw: line,
      });
      continue;
    }

    if (/drzavni praznici i neradni dani/.test(n)) {
      inHolidays = true;
      continue;
    }

    if (/^\S+\s+ispitni rok odrzava se\s/.test(n)) {
      inHolidays = false;
      const label = line.split(/\s+/)[0];
      examPeriod = {
        name: slugify(label),
        label,
        held: periodIn(line),
        examRegistration: null,
        sittings: [],
      };
      calendar.examPeriods.push(examPeriod);
      continue;
    }

    if (examPeriod && /^(prvo|drugo) polaganje/.test(n)) {
      examPeriod.sittings.push({
        ...periodIn(line),
        name: n.startsWith("prvo") ? "prvo_polaganje" : "drugo_polaganje",
        examRegistration: null,
      });
      continue;
    }

    if (examPeriod && /prijava ispita/.test(n)) {
      const lastSitting = examPeriod.sittings[examPeriod.sittings.length - 1];
      if (lastSitting) {
        lastSitting.examRegistration = periodIn(line);
      } else {
        examPeriod.examRegistration = periodIn(line);
      }
      continue;
    }

    if (inHolidays && /^\d/.test(line)) {
      calendar.nonWorkingDaysAndHolidays.push({
        dates: numericDatesIn(line),
        note: line,
        raw: line,
      });
      continue;
    }

    if (
      !examPeriod &&
      /(dodela indeksa|pocetak nastave|upis godine|organizuje se nastava|svecana dodela)/.test(
        n,
      )
    ) {
      calendar.notes.push(line);
    }
  }

  return calendar;
}

function toLines($: cheerio.CheerioAPI): string[] {
  $(NOISE).remove();
  return $(BLOCKS)
    .filter((_, el) => $(el).find(BLOCKS).length === 0)
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((line) => line.length > 0);
}

function periodIn(line: string): Period {
  const match = RANGE.exec(latinSearchText(line));
  if (match) {
    const [from, to] = [match[1], match[2]].map(
      (date) => numericDatesIn(`${date}.`)[0],
    );
    return { from: from ?? null, to: to ?? null, raw: line };
  }
  const dates = numericDatesIn(line);
  return {
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    raw: line,
  };
}

function assertParsed(calendar: Calendar): void {
  const missing = [
    calendar.examPeriods.length === 0 && "ispitni rokovi",
    !calendar.semesters.autumn && !calendar.semesters.spring && "semestri",
    calendar.nonWorkingDaysAndHolidays.length === 0 && "neradni dani/praznici",
  ].filter((item): item is string => typeof item === "string");

  if (missing.length > 0) {
    throw new Error(`${calendar.label}: not found`);
  }
}

export async function scrapeActivityCalendar(
  requestedYear?: string,
): Promise<void> {
  const academicYear = requireAcademicYear(requestedYear, "update:kalendar");
  const levels: Calendar[] = [];

  for (const source of sourcesFor(academicYear)) {
    const calendar = parseCalendar(
      source,
      cheerio.load(await fetchHtml(source.url)),
    );
    assertParsed(calendar);
    levels.push(calendar);
  }

  const output: ActivityCalendarDocument = {
    schemaVersion: 1,
    category: "kalendar_aktivnosti",
    language: "sr",
    academicYear,
    generatedAt: new Date().toISOString(),
    levels,
  };

  const destination = dataFile(
    `kalendar-aktivnosti-${academicYearSlug(academicYear)}.json`,
  );
  writeJson(destination, output);
}

function sourcesFor(academicYear: string) {
  const slug = academicYearSlug(academicYear);
  return [
    {
      studyLevel: "osnovne_akademske",
      label: "OAS",
      url: `${SITE_ORIGIN}/article/kalendar/kalendar-aktivnosti-${slug}`,
    },
    {
      studyLevel: "master_akademske",
      label: "MAS",
      url: `${SITE_ORIGIN}/article/kalendar/kalendar-aktivnosti-mas-${slug}`,
    },
  ] as const;
}

if (require.main === module) {
  runCli(
    () => scrapeActivityCalendar(process.argv[2]),
    "Error scraping activity calendar",
  );
}
