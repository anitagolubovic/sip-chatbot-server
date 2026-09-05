import "dotenv/config";
import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "./pool";
import {
  insertRows,
  parseIngestArguments,
  readSourceFile,
  recordSourceFile,
  runIngestCli,
  type IngestOptions,
} from "./ingestRuntime";
import { buildChunks, toSearchForm } from "../preprocessing";
import { Category } from "../models/categories";
import type { DocumentationDocument } from "../models/documentation";
import {
  academicYearSlug,
  currentAcademicYear,
  dataFile,
} from "../scraper/lib/scraperRuntime";

const CHUNK_COLUMNS = [
  "document_id",
  "ord",
  "heading",
  "text",
  "text_norm",
  "token_count",
  "filters",
] as const;

/** Zajednicki oblik zapisa iz oba tekstualna izvora. */
type TextualRecord = {
  title: string;
  summary: string;
  publishedAt: string;
  sourceUrl: string;
  content: { paragraphs: string[]; listItems: string[] };
  [field: string]: unknown;
};

type TextualDocument = {
  category: string;
  academicYear: string;
  records: TextualRecord[];
};

type TextualSource = {
  category: Category;
  file: (academicYear: string) => string;
  /** Polja koja se cuvaju za kasnije filtriranje pretrage. */
  filters: (record: TextualRecord) => Record<string, unknown>;
};

const SOURCES: readonly TextualSource[] = [
  {
    category: Category.Documentation,
    file: (year) => dataFile(`dokumentacija-${academicYearSlug(year)}.json`),
    filters: (record) => ({
      procedureTypes: record.procedureTypes ?? [],
      studyLevels: record.studyLevels ?? [],
      temporalScope: record.temporalScope ?? null,
      sourceCategory: record.sourceCategory ?? null,
    }),
  },
  {
    category: Category.Opportunities,
    file: (year) => dataFile(`konkursi-${academicYearSlug(year)}.json`),
    filters: (record) => ({
      activityTypes: record.activityTypes ?? [],
      sourceCategory: record.sourceCategory ?? null,
    }),
  },
];

function recordHash(record: TextualRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

async function storeRecord(
  client: PoolClient,
  source: TextualSource,
  academicYear: string,
  record: TextualRecord,
): Promise<"inserted" | "updated" | "unchanged"> {
  const contentHash = recordHash(record);
  const existing = await client.query<{ id: number; content_hash: string }>(
    "SELECT id, content_hash FROM documents WHERE source_url = $1",
    [record.sourceUrl],
  );

  // Cuvanje vec izracunatih embeddinga: nepromenjen zapis se ne dira.
  if (existing.rows[0]?.content_hash === contentHash) {
    return "unchanged";
  }

  const filters = source.filters(record);
  const stored = await client.query<{ id: number }>(
    `INSERT INTO documents
       (source_url, category, academic_year, published_at, title, title_norm,
        summary, filters, raw, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source_url) DO UPDATE
       SET category = EXCLUDED.category,
           academic_year = EXCLUDED.academic_year,
           published_at = EXCLUDED.published_at,
           title = EXCLUDED.title,
           title_norm = EXCLUDED.title_norm,
           summary = EXCLUDED.summary,
           filters = EXCLUDED.filters,
           raw = EXCLUDED.raw,
           content_hash = EXCLUDED.content_hash,
           ingested_at = now()
     RETURNING id`,
    [
      record.sourceUrl,
      source.category,
      academicYear,
      record.publishedAt || null,
      record.title,
      toSearchForm(record.title),
      record.summary || null,
      JSON.stringify(filters),
      JSON.stringify(record),
      contentHash,
    ],
  );

  const documentId = stored.rows[0].id;
  await client.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);

  const chunks = buildChunks({
    category: source.category,
    title: record.title,
    academicYear,
    summary: record.summary,
    paragraphs: [
      ...(record.content?.paragraphs ?? []),
      ...(record.content?.listItems ?? []),
    ],
  });

  await insertRows(
    client,
    "chunks",
    CHUNK_COLUMNS,
    chunks.map((chunk) => [
      documentId,
      chunk.ord,
      chunk.heading,
      chunk.text,
      chunk.textNorm,
      chunk.tokenCount,
      JSON.stringify(filters),
    ]),
  );

  return existing.rows.length > 0 ? "updated" : "inserted";
}

export async function ingestTextual(
  requestedYear?: string,
  options: IngestOptions = {},
): Promise<void> {
  const academicYear = requestedYear ?? currentAcademicYear();

  for (const source of SOURCES) {
    const { path, document, contentHash } = readSourceFile<
      TextualDocument & DocumentationDocument
    >(source.file(academicYear));

    if (document.category !== source.category) {
      throw new Error(
        `${path} has category "${document.category}", expected "${source.category}".`,
      );
    }

    const records = document.records as unknown as TextualRecord[];
    if (records.length === 0) {
      throw new Error(`${path} contains no records.`);
    }

    await withTransaction(async (client) => {
      const counts = { inserted: 0, updated: 0, unchanged: 0 };

      for (const record of records) {
        if (options.force) {
          await client.query(
            "UPDATE documents SET content_hash = '' WHERE source_url = $1",
            [record.sourceUrl],
          );
        }
        counts[await storeRecord(client, source, academicYear, record)] += 1;
      }

      // Zapisi povuceni sa sajta ne smeju da ostanu u pretrazi.
      const removed = await client.query(
        `DELETE FROM documents
         WHERE category = $1 AND academic_year = $2
           AND source_url <> ALL($3::text[])`,
        [source.category, academicYear, records.map((item) => item.sourceUrl)],
      );

      await recordSourceFile(client, path, contentHash, records.length);

      console.log(
        `${path}: ${counts.inserted} new, ${counts.updated} updated, ` +
          `${counts.unchanged} unchanged, ${removed.rowCount ?? 0} removed.`,
      );
    });
  }
}

if (require.main === module) {
  const { academicYear, options } = parseIngestArguments(process.argv.slice(2));
  runIngestCli(
    () => ingestTextual(academicYear, options),
    "Textual ingest failed:",
  );
}
