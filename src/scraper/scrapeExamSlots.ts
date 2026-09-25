import { fetchHtml, SITE_ORIGIN } from "./lib/httpClient";
import {
  belongsToAcademicYear,
  hasNextPage,
  parseListing,
  type ListingItem,
} from "./lib/opportunityParser";
import {
  examPeriodOfTitle,
  parseExamSlotTable,
  studyLevelOfTitle,
} from "./lib/examSlotParser";
import {
  academicYearSlug,
  dataFile,
  paginatedUrl,
  requireAcademicYear,
  runCli,
  writeJson,
} from "./lib/scraperRuntime";
import type {
  ExamSlotPage,
  ExamSlotsDocument,
} from "../models/examSchedule";

const LISTING_URL = `${SITE_ORIGIN}/category/polaganje-ispita`;
const MAX_PAGES = 10;

export async function scrapeExamSlots(requestedYear?: string): Promise<void> {
  const academicYear = requireAcademicYear(requestedYear, "update:satnica");
  const pages: ExamSlotPage[] = [];

  for (const item of await findSlotArticles(academicYear)) {
    const examPeriod = examPeriodOfTitle(item.title, item.url);
    if (!examPeriod) {
      console.warn(
        `[satnica] Exam period not recognized in "${item.title}" (${item.url}), skipping.`,
      );
      continue;
    }

    const slots = parseExamSlotTable(
      await fetchHtml(item.url),
      studyLevelOfTitle(item.title),
    );
    if (slots.length === 0) {
      console.warn(
        `[satnica] No exam slot table in "${item.title}" (${item.url}), skipping.`,
      );
      continue;
    }

    pages.push({
      examPeriod,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      slots,
    });
  }

  // Satnica se objavljuje tek pred rok, pa na pocetku skolske godine nijedna
  // jos ne postoji; to nije greska, ingest tada radi samo sa rasporedom.
  if (pages.length === 0) {
    console.warn(`[satnica] No exam slot pages published for ${academicYear} yet.`);
  }

  pages.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  const output: ExamSlotsDocument = {
    schemaVersion: 1,
    category: "satnica_ispita",
    language: "sr",
    academicYear,
    sourceUrl: LISTING_URL,
    generatedAt: new Date().toISOString(),
    pages,
  };

  writeJson(
    dataFile(`satnica-ispita-${academicYearSlug(academicYear)}.json`),
    output,
  );
}

async function findSlotArticles(academicYear: string): Promise<ListingItem[]> {
  const oldestRelevantPublication = `${academicYear.slice(0, 4)}-09-01`;
  const found: ListingItem[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const html = await fetchHtml(paginatedUrl(LISTING_URL, page));
    const items = parseListing(html);
    if (items.length === 0) break;

    for (const item of items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      if (
        item.url.includes("satnica") &&
        belongsToAcademicYear(item, academicYear)
      ) {
        found.push(item);
      }
    }

    if (items.every((item) => item.publishedAt < oldestRelevantPublication)) {
      break;
    }
    if (!hasNextPage(html, page)) break;
  }

  return found;
}

if (require.main === module) {
  runCli(
    () => scrapeExamSlots(process.argv[2]),
    "Error while scraping exam slots. The page format may have changed.",
  );
}
