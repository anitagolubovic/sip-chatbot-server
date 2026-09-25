import { fetchHtml } from "./lib/httpClient";
import {
  SOURCES,
  academicYearsIn,
  calendarYearInTitle,
  calendarYearsIn,
  classifyRelevant,
  hasNextPage,
  inferStudyLevels,
  parseArticle,
  parseListing,
  type ListingItem,
  type SourceSlug,
} from "./lib/documentationParser";
import {
  academicYearSlug,
  dataFile,
  paginatedUrl,
  requireAcademicYear,
  runCli,
  writeJson,
} from "./lib/scraperRuntime";
import type {
  DocumentationDocument,
  DocumentationRecord,
} from "../models/documentation";
import { Maybe } from "../models/types";

const MAX_PAGES = 20;

type Candidate = ListingItem & {
  sourceCategory: SourceSlug;
  procedures: ReturnType<typeof classifyRelevant>;
  academicYear: Maybe<string>;
  calendarYear: Maybe<number>;
};

export async function scrapeDocumentation(
  requestedYear?: string,
): Promise<void> {
  const academicYear = requireAcademicYear(
    requestedYear,
    "update:dokumentacija",
  );

  const now = new Date();
  const candidates = await collectCandidates();
  if (candidates.length === 0) {
    throw new Error(
      "Not found any relevant articles; existing JSON not replaced.",
    );
  }

  const loaded = [];
  for (const candidate of candidates) {
    if (candidate.academicYear && candidate.academicYear !== academicYear) {
      continue;
    }
    if (
      !candidate.academicYear &&
      candidate.calendarYear &&
      candidate.calendarYear !== now.getFullYear()
    ) {
      continue;
    }
    const parsed = parseArticle(await fetchHtml(candidate.url), candidate.url);
    const bodyAcademicYears = academicYearsIn(parsed.text);
    const bodyCalendarYears = calendarYearsIn(parsed.text);

    let resolvedAcademicYear = candidate.academicYear;
    let resolvedCalendarYear = candidate.calendarYear;

    if (!resolvedAcademicYear && bodyAcademicYears.length) {
      if (!bodyAcademicYears.includes(academicYear)) continue;
      resolvedAcademicYear = academicYear;
    }
    if (
      !resolvedAcademicYear &&
      !resolvedCalendarYear &&
      bodyCalendarYears.length
    ) {
      if (!bodyCalendarYears.includes(now.getFullYear())) continue;
      resolvedCalendarYear = now.getFullYear();
    }

    loaded.push({
      candidate: {
        ...candidate,
        academicYear: resolvedAcademicYear,
        calendarYear: resolvedCalendarYear,
      },
      parsed,
    });
  }

  const relevantUrls = new Set(loaded.map(({ candidate }) => candidate.url));
  const records: DocumentationRecord[] = loaded.map(
    ({ candidate, parsed }) => ({
      procedureTypes: candidate.procedures,
      studyLevels: inferStudyLevels(
        candidate.sourceCategory,
        candidate.title,
        parsed.text,
      ),
      temporalScope: candidate.academicYear
        ? "skolska_godina"
        : candidate.calendarYear
          ? "kalendarska_godina"
          : "opste",
      academicYear: candidate.academicYear,
      calendarYear: candidate.calendarYear,
      title: candidate.title,
      summary: candidate.summary,
      publishedAt: candidate.publishedAt,
      sourceCategory: candidate.sourceCategory,
      sourceUrl: candidate.url,
      content: {
        paragraphs: parsed.paragraphs,
        listItems: parsed.listItems,
      },
      attachments: parsed.attachments,
      relatedRelevantPages: parsed.internalLinks.filter((link) =>
        relevantUrls.has(link.url),
      ),
    }),
  );

  records.sort(
    (a, b) =>
      b.publishedAt.localeCompare(a.publishedAt) ||
      a.title.localeCompare(b.title, "sr"),
  );

  const output: DocumentationDocument = {
    schemaVersion: 1,
    category: "studentska_dokumentacija",
    language: "sr",
    academicYear,
    generatedAt: now.toISOString(),
    records,
  };

  const destination = outputFile(academicYear);
  writeJson(destination, output);
}

async function collectCandidates(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const source of SOURCES) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const html = await fetchHtml(paginatedUrl(source.url, page));
      const listing = parseListing(html);
      if (listing.length === 0) break;

      for (const item of listing) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        const procedures = classifyRelevant(item.title, item.summary);
        if (procedures.length === 0) continue;
        const years = detectCandidateYear(item);
        const candidate: Candidate = {
          ...item,
          sourceCategory: source.slug,
          procedures,
          ...years,
        };
        candidates.push(candidate);
      }

      if (!hasNextPage(html, page)) break;
    }
  }

  return candidates;
}

function detectCandidateYear(item: ListingItem): {
  academicYear: Maybe<string>;
  calendarYear: Maybe<number>;
} {
  const titleYears = academicYearsIn(item.title);
  const slugYears = academicYearsIn(item.url.split("/").pop() ?? "");
  const summaryYears = academicYearsIn(item.summary);
  return {
    academicYear: titleYears[0] ?? slugYears[0] ?? summaryYears[0] ?? null,
    calendarYear: calendarYearInTitle(item.title),
  };
}

function outputFile(academicYear: string): string {
  return dataFile(`dokumentacija-${academicYearSlug(academicYear)}.json`);
}

if (require.main === module) {
  runCli(
    () => scrapeDocumentation(process.argv[2]),
    "Error while scraping documentation.",
  );
}
