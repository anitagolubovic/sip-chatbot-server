import "dotenv/config";
import OpenAI from "openai";
import { query, withTransaction } from "./pool";
import { parseIngestArguments, runIngestCli } from "./ingestRuntime";
import { toSearchForm } from "../preprocessing";

export const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

/** Mora da odgovara VECTOR(1536) iz sheme. */
export const EMBEDDING_DIMENSIONS = 1536;

// Jedan zahtev nosi vise delova; granica je konzervativna zbog duzine ulaza.
const BATCH_SIZE = 64;

type PendingChunk = { id: number; heading: string; text: string };

/** Naslov nosi kategoriju, naziv zapisa i godinu, pa ulazi u vektor uz telo. */
function embeddingInput(chunk: PendingChunk): string {
  return `${chunk.heading}\n${chunk.text}`;
}

export async function embedChunks(
  options: {
    force?: boolean;
  } = {},
): Promise<void> {
  const pending = await query<PendingChunk>(
    `SELECT id, heading, text FROM chunks
     WHERE $1::boolean OR embedding IS NULL
     ORDER BY id`,
    [options.force ?? false],
  );

  if (pending.length === 0) {
    console.log("All chunks already have embeddings.");
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let embedded = 0;
  let tokens = 0;

  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE);

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch.map(embeddingInput),
    });

    const dimensions = response.data[0]?.embedding.length;
    if (dimensions !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Model ${EMBEDDING_MODEL} returns ${dimensions}-dimensional vectors, ` +
          `but the schema stores VECTOR(${EMBEDDING_DIMENSIONS}).`,
      );
    }

    tokens += response.usage?.total_tokens ?? 0;

    await withTransaction(async (client) => {
      for (const [index, item] of response.data.entries()) {
        await client.query("UPDATE chunks SET embedding = $1 WHERE id = $2", [
          JSON.stringify(item.embedding),
          batch[index].id,
        ]);
      }
    });

    embedded += batch.length;
    console.log(`  ${embedded}/${pending.length} chunks embedded`);
  }

  console.log(
    `Embedded ${embedded} chunks with ${EMBEDDING_MODEL} (${tokens} tokens).`,
  );
}

if (require.main === module) {
  const { options } = parseIngestArguments(process.argv.slice(2));
  runIngestCli(() => embedChunks(options), "Embedding failed:");
}
