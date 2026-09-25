import { fetchHtml } from "./lib/httpClient";
import {
  ACTIVITY_SOURCES,
  belongsToAcademicYear,
  classifyActivity,
  hasNextPage,
  parseActivityArticle,
  parseListing,
  type ActivitySource,
} from "./lib/opportunityParser";
import {
  academicYearSlug,
  dataFile,
  paginatedUrl,
  requireAcademicYear,
  runCli,
  writeJson,
} from "./lib/scraperRuntime";

const MAX_PAGES = 40;

export async function scrapeOpportunities(
  requestedYear?: string,
): Promise<void> {
  const academicYear = requireAcademicYear(requestedYear, "update:konkursi");

  const candidates: Array<{
    title: string;
    summary: string;
    url: string;
    publishedAt: string;
    sourceCategory: ActivitySource;
    activityTypes: ReturnType<typeof classifyActivity>;
  }> = [];
  const seen = new Set<string>();
  const oldestRelevantPublication = `${academicYear.slice(0, 4)}-01-01`;

  for (const source of ACTIVITY_SOURCES) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const html = await fetchHtml(paginatedUrl(source.url, page));
      const items = parseListing(html);
      if (items.length === 0) break;
      for (const item of items) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        if (!belongsToAcademicYear(item, academicYear)) continue;
        const activityTypes = classifyActivity(item.title, item.summary);
        if (activityTypes.length === 0) continue;
        candidates.push({
          ...item,
          sourceCategory: source.slug,
          activityTypes,
        });
      }

      if (items.every((item) => item.publishedAt < oldestRelevantPublication)) {
        break;
      }
      if (!hasNextPage(html, page)) break;
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      "Not found any relevant activities for the requested academic year.",
    );
  }

  const records = [];
  for (const candidate of candidates) {
    const article = parseActivityArticle(
      await fetchHtml(candidate.url),
      candidate.url,
    );
    records.push({
      activityTypes: candidate.activityTypes,
      title: candidate.title,
      summary: candidate.summary,
      publishedAt: candidate.publishedAt,
      sourceCategory: candidate.sourceCategory,
      sourceUrl: candidate.url,
      content: {
        paragraphs: article.paragraphs,
        listItems: article.listItems,
      },
      resources: article.resources,
    });
  }

  records.sort(
    (a, b) =>
      b.publishedAt.localeCompare(a.publishedAt) ||
      a.title.localeCompare(b.title, "sr"),
  );

  const output = {
    schemaVersion: 1,
    category: "konkursi_i_promovisane_aktivnosti",
    language: "sr",
    academicYear,
    generatedAt: new Date().toISOString(),
    records,
  };

  const destination = outputFile(academicYear);
  writeJson(destination, output);
}

function outputFile(academicYear: string): string {
  return dataFile(`konkursi-${academicYearSlug(academicYear)}.json`);
}

if (require.main === module) {
  runCli(
    () => scrapeOpportunities(process.argv[2]),
    "Error while scraping opportunities.",
  );
}
