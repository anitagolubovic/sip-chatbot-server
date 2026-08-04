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

const MAX_PAGES = 20;

type Candidate = ListingItem & {
  sourceCategory: SourceSlug;
  procedures: ReturnType<typeof classifyRelevant>;
  academicYear: string | null;
  calendarYear: number | null;
};

function outputFile(academicYear: string): string {
  return dataFile(`dokumentacija-${academicYearSlug(academicYear)}.json`);
}

function detectCandidateYear(item: ListingItem): {
  academicYear: string | null;
  calendarYear: number | null;
} {
  const titleYears = academicYearsIn(item.title);
  const slugYears = academicYearsIn(item.url.split("/").pop() ?? "");
  const summaryYears = academicYearsIn(item.summary);
  return {
    academicYear: titleYears[0] ?? slugYears[0] ?? summaryYears[0] ?? null,
    calendarYear: calendarYearInTitle(item.title),
  };
}

async function collectCandidates(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const source of SOURCES) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const html = await fetchHtml(paginatedUrl(source.url, page));
      const listing = parseListing(html);
      if (!listing.length) break;

      for (const item of listing) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        const procedures = classifyRelevant(item.title, item.summary);
        if (!procedures.length) continue;
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

export async function scrapeDocumentation(requestedYear?: string): Promise<void> {
  const academicYear = requireAcademicYear(requestedYear, "update:dokumentacija");

  const now = new Date();
  const candidates = await collectCandidates();
  if (!candidates.length) {
    throw new Error(
      "Nije pronadjen nijedan relevantan clanak; postojeci JSON nije zamenjen.",
    );
  }

  const loaded = [];
  for (const candidate of candidates) {
    if (
      candidate.academicYear &&
      candidate.academicYear !== academicYear
    ) {
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
  const records: DocumentationRecord[] = loaded.map(({ candidate, parsed }) => ({
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
  }));

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

  const attachmentCount = records.reduce(
    (sum, record) => sum + record.attachments.length,
    0,
  );
  console.log(
    `Sacuvano ${records.length} relevantnih zapisa i ${attachmentCount} priloga u ${destination}`,
  );
}

if (require.main === module) {
  runCli(
    () => scrapeDocumentation(process.argv[2]),
    "Greska pri preuzimanju dokumentacije:",
  );
}
