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
  IspitniRok,
  Kalendar,
  Period,
} from "../models/calendar";

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

type Source = ReturnType<typeof sourcesFor>[number];

const RANGE =
  /\bod\s+(\d{1,2}\.\d{1,2}\.\d{4})\.\s*do\s+(\d{1,2}\.\d{1,2}\.\d{4})\./;

function periodIn(line: string): Period {
  const match = RANGE.exec(latinSearchText(line));
  if (match) {
    const [od, doDatuma] = [match[1], match[2]].map(
      (date) => numericDatesIn(`${date}.`)[0],
    );
    return { od: od ?? null, do: doDatuma ?? null, raw: line };
  }
  const dates = numericDatesIn(line);
  return {
    od: dates[0] ?? null,
    do: dates[dates.length - 1] ?? null,
    raw: line,
  };
}

function noteInParens(line: string): string {
  return line.match(/\(([^)]+)\)/)?.[1].trim() ?? "";
}

const NOISE = "script, style, noscript, nav, header, footer, form";
const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt";

function toLines($: cheerio.CheerioAPI): string[] {
  $(NOISE).remove();
  return $(BLOCKS)
    .filter((_, el) => $(el).find(BLOCKS).length === 0)
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((line) => line.length > 0);
}

function findPdfUrl($: cheerio.CheerioAPI): string | null {
  return (
    pdfLinks($).find((link) => link.url.includes("kalendar-aktivnosti"))?.url ??
    null
  );
}

function parseKalendar(source: Source, $: cheerio.CheerioAPI): Kalendar {
  const lines = toLines($);

  const kalendar: Kalendar = {
    studyLevel: source.studyLevel,
    label: source.label,
    sourceUrl: source.url,
    pdfUrl: findPdfUrl($),
    semestri: { jesenji: null, prolecni: null },
    raspust: null,
    overaSemestra: null,
    radniDani: [],
    neradniDaniIPraznici: [],
    ispitniRokovi: [],
    napomene: [],
    rawText: lines.join("\n"),
  };

  let uPraznicima = false;
  let rok: IspitniRok | null = null;

  for (const line of lines) {
    const n = latinSearchText(line);

    if (/jesenji semestar/.test(n) && /pocinje/.test(n)) {
      kalendar.semestri.jesenji = periodIn(line);
      continue;
    }

    if (/prolecni semestar/.test(n) && /pocinje/.test(n)) {
      kalendar.semestri.prolecni = periodIn(line);
      continue;
    }

    if (/raspust/.test(n)) {
      kalendar.raspust = periodIn(line);
      continue;
    }

    if (/^overa/.test(n)) {
      kalendar.overaSemestra = line;
      continue;
    }

    if (/je radna/.test(n)) {
      uPraznicima = false;
      kalendar.radniDani.push({
        datumi: numericDatesIn(line),
        napomena: noteInParens(line),
        raw: line,
      });
      continue;
    }

    if (/drzavni praznici i neradni dani/.test(n)) {
      uPraznicima = true;
      continue;
    }

    if (/^\S+\s+ispitni rok odrzava se\s/.test(n)) {
      uPraznicima = false;
      const labela = line.split(/\s+/)[0];
      rok = {
        naziv: slugify(labela),
        labela,
        odrzavanje: periodIn(line),
        prijavaIspita: null,
        polaganja: [],
      };
      kalendar.ispitniRokovi.push(rok);
      continue;
    }

    if (rok && /^(prvo|drugo) polaganje/.test(n)) {
      rok.polaganja.push({
        ...periodIn(line),
        naziv: n.startsWith("prvo") ? "prvo_polaganje" : "drugo_polaganje",
        prijavaIspita: null,
      });
      continue;
    }

    if (rok && /prijava ispita/.test(n)) {
      const poslednjePolaganje = rok.polaganja[rok.polaganja.length - 1];
      if (poslednjePolaganje) {
        poslednjePolaganje.prijavaIspita = periodIn(line);
      } else {
        rok.prijavaIspita = periodIn(line);
      }
      continue;
    }

    if (uPraznicima && /^\d/.test(line)) {
      kalendar.neradniDaniIPraznici.push({
        datumi: numericDatesIn(line),
        napomena: line,
        raw: line,
      });
      continue;
    }

    if (
      !rok &&
      /(dodela indeksa|pocetak nastave|upis godine|organizuje se nastava|svecana dodela)/.test(
        n,
      )
    ) {
      kalendar.napomene.push(line);
    }
  }

  return kalendar;
}

function assertParsed(kalendar: Kalendar): void {
  const missing = [
    kalendar.ispitniRokovi.length === 0 && "ispitni rokovi",
    !kalendar.semestri.jesenji && !kalendar.semestri.prolecni && "semestri",
    kalendar.neradniDaniIPraznici.length === 0 && "neradni dani/praznici",
  ].filter((item): item is string => typeof item === "string");

  if (missing.length > 0) {
    throw new Error(
      `${kalendar.label}: nije prepoznato (${missing.join(", ")}) na ` +
        `${kalendar.sourceUrl}. Stranica je verovatno promenila format - ` +
        `proveri kljucne reci u parseKalendar.`,
    );
  }
}

export async function scrapeActivityCalendar(
  requestedYear?: string,
): Promise<void> {
  const academicYear = requireAcademicYear(requestedYear, "update:kalendar");
  const levels: Kalendar[] = [];

  for (const source of sourcesFor(academicYear)) {
    const kalendar = parseKalendar(
      source,
      cheerio.load(await fetchHtml(source.url)),
    );
    assertParsed(kalendar);
    levels.push(kalendar);
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
  console.log(`Sacuvan kalendar za ${levels.length} nivoa u ${destination}`);
}

if (require.main === module) {
  runCli(
    () => scrapeActivityCalendar(process.argv[2]),
    "Greska prilikom scrape-ovanja kalendara aktivnosti:",
  );
}
