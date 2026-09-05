import OpenAI from "openai";
import { query } from "../db/pool";
import { EMBEDDING_MODEL } from "../db/embedChunks";
import { toSearchForm } from "../preprocessing";
import { Category } from "../models/categories";
import { Maybe } from "../models/types";
import { formatDate } from "./questionParsing";

/**
 * Konstanta iz RRF-a (Reciprocal Rank Fusion). Sto je veca, to su razlike
 * izmedju prvih mesta manje bitne; 60 je vrednost iz originalnog rada.
 */
const RRF_K = 60;

/** Koliko rezultata svaki pretrazivac daje pre spajanja. */
const CANDIDATES_PER_SEARCH = 20;

/** Koliko delova ide u kontekst. Svaki je do 400 tokena. */
const MAX_CHUNKS = 3;

/**
 * Kosinusna udaljenost preko koje se vektorski pogodak odbacuje. Bez nje bi
 * pretraga uvek vratila "najblize" delove, i za pitanja koja nemaju veze sa
 * tekstualnim izvorima.
 */
const STRONG_VECTOR_DISTANCE = 0.45;

/**
 * Gornja granica za vektorsku potvrdu leksickog pogotka. Izmereno na korpusu:
 * tacni pogoci koji zavise od ove provere stoje na 0.52, a najblizi netacni na
 * 0.54, pa je granica tesna i treba je ponovo izmeriti kad se korpus prosiri.
 */
const SUPPORTING_VECTOR_DISTANCE = 0.53;

/** Najmanja slicnost naslova sa pitanjem da bi trigram pretraga prijavila pogodak. */
const MIN_TITLE_SIMILARITY = 0.5;

/**
 * Upitne reci i veznici. U tsvectoru se koristi konfiguracija "simple", koja
 * ne poznaje srpske stop-reci, pa bi "kako", "da" i "o" inace ulazili u upit.
 */
const STOP_WORDS = new Set([
  "a",
  "ako",
  "ali",
  "bez",
  "bi",
  "bih",
  "ce",
  "cu",
  "da",
  "do",
  "dok",
  "gde",
  "i",
  "ih",
  "ili",
  "ima",
  "imam",
  "iz",
  "ja",
  "je",
  "jel",
  "jer",
  "kad",
  "kada",
  "kako",
  "kakav",
  "kakva",
  "kakvo",
  "koja",
  "koje",
  "koji",
  "koliko",
  "li",
  "me",
  "mi",
  "mogu",
  "moze",
  "na",
  "nam",
  "nas",
  "ne",
  "nego",
  "neka",
  "nema",
  "ni",
  "nije",
  "o",
  "od",
  "pa",
  "po",
  "pre",
  "sam",
  "se",
  "si",
  "sta",
  "ste",
  "sto",
  "su",
  "sve",
  "ta",
  "te",
  "ti",
  "to",
  "tu",
  "u",
  "uz",
  "za",
  "zar",
  "zasto",
  "sam",
  "treba",
  "molim",
  "hvala",
]);

/**
 * OR upit od sadrzajnih reci. plainto_tsquery bi ih spojio sa AND, pa bi jedna
 * nepogodjena rec ponistila ceo upit.
 */
/**
 * Udeo delova koje jedna rec sme da pogodi da bi ostala u upitu. Na studentskom
 * portalu "student" stoji u 80% tekstova i samo razblazuje rangiranje.
 */
const MAX_DOCUMENT_FREQUENCY = 0.4;

export function lexicalTerms(normalizedQuestion: string): string[] {
  const words = normalizedQuestion
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  return [...new Set(words.map(searchStem))];
}

/**
 * Izbacuje prerasprostranjene reci. Racuna se stvarna frekvencija u korpusu,
 * umesto rucnog spiska, da bi pravilo pratilo podatke. Ako bi sve reci ispale,
 * zadrzava se najredja.
 */
export async function lexicalQuery(
  normalizedQuestion: string,
): Promise<Maybe<string>> {
  const terms = lexicalTerms(normalizedQuestion);
  if (terms.length === 0) return null;

  const frequencies = await query<{ term: string; ratio: number }>(
    `SELECT t.term,
            (SELECT count(*) FROM chunks c
             WHERE c.tsv @@ to_tsquery('simple', t.term))::float8
            / NULLIF((SELECT count(*) FROM chunks), 0) AS ratio
     FROM unnest($1::text[]) AS t(term)
     ORDER BY ratio`,
    [terms],
  );

  const informative = frequencies.filter(
    (row) => row.ratio > 0 && row.ratio <= MAX_DOCUMENT_FREQUENCY,
  );
  const kept = informative.length > 0 ? informative : frequencies.slice(0, 1);

  return kept.length > 0 ? kept.map((row) => row.term).join(" | ") : null;
}

/**
 * Konfiguracija "simple" ne stemuje, pa "praksi" ne bi naslo "praksu". Duze
 * reci se skracuju za dva znaka i traze kao prefiks, sto pokriva srpske
 * padezne nastavke bez pravog stemera.
 */
function searchStem(word: string): string {
  if (word.length <= 3) return word;
  // Prefiks nikad kraci od pet znakova: "prak:*" bi hvatao i "praktikum".
  const cut = Math.max(5, word.length - 2);
  return `${word.slice(0, cut)}:*`;
}

export type TextHit = {
  chunkId: number;
  title: string;
  sourceUrl: string;
  publishedAt: Maybe<string>;
  category: string;
  heading: string;
  text: string;
  vectorDistance: Maybe<number>;
  lexicalRank: Maybe<number>;
  trigramScore: Maybe<number>;
  score: number;
};

let openai: Maybe<OpenAI> = null;

function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/** Pitanje se embeduje u istom normalizovanom obliku kao i delovi teksta. */
export async function embedQuestion(question: string): Promise<number[]> {
  const response = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input: toSearchForm(question),
  });
  return response.data[0].embedding;
}

/**
 * Hibridna pretraga: vektorska (znacenje), full-text (tacne reci) i trigram
 * (greske u kucanju). Rezultati se spajaju RRF-om, koji sabira reciprocne
 * pozicije umesto rezultata, pa se tri nesamerljive skale ne moraju kalibrisati.
 */
export async function searchChunks(
  question: string,
  category: Maybe<Category>,
): Promise<TextHit[]> {
  const normalizedQuestion = toSearchForm(question);
  const lexical = await lexicalQuery(normalizedQuestion);
  const embedding = JSON.stringify(await embedQuestion(question));

  return query<TextHit>(
    `WITH parameters AS (
       SELECT $1::vector AS embedding,
              $2::text AS question,
              CASE WHEN $8::text IS NULL THEN NULL
                   ELSE to_tsquery('simple', $8) END AS ts_question,
              $3::text AS category
     ),
     eligible AS (
       SELECT c.id, c.text_norm, c.tsv, c.embedding, d.title_norm
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE (SELECT category FROM parameters) IS NULL
          OR d.category = (SELECT category FROM parameters)
     ),
     vector_hits AS (
       SELECT id,
              c.embedding <=> (SELECT embedding FROM parameters) AS distance,
              row_number() OVER (
                ORDER BY c.embedding <=> (SELECT embedding FROM parameters)
              ) AS rank
       FROM eligible c
       WHERE c.embedding IS NOT NULL
       ORDER BY distance
       LIMIT $4
     ),
     lexical_hits AS (
       SELECT id,
              row_number() OVER (
                ORDER BY ts_rank(c.tsv, (SELECT ts_question FROM parameters)) DESC
              ) AS rank
       FROM eligible c
       WHERE c.tsv @@ (SELECT ts_question FROM parameters)
       LIMIT $4
     ),
     trigram_hits AS (
       -- Oba smera: "Zimska praksa u ELSYS" prema pitanju daje 0.40, a pitanje
       -- prema naslovu 0.64, jer je naslov duzi od onoga sto je pitano.
       SELECT id,
              greatest(
                word_similarity(c.title_norm, (SELECT question FROM parameters)),
                word_similarity((SELECT question FROM parameters), c.title_norm)
              ) AS score,
              row_number() OVER (
                ORDER BY greatest(
                  word_similarity(c.title_norm, (SELECT question FROM parameters)),
                  word_similarity((SELECT question FROM parameters), c.title_norm)
                ) DESC
              ) AS rank
       FROM eligible c
       WHERE greatest(
               word_similarity(c.title_norm, (SELECT question FROM parameters)),
               word_similarity((SELECT question FROM parameters), c.title_norm)
             ) >= $5
       ORDER BY score DESC
       LIMIT $4
     ),
     fused AS (
       SELECT id,
              sum(weight)::float8 AS score,
              max(distance) AS distance,
              max(lexical_rank) AS lexical_rank,
              max(trigram_score) AS trigram_score
       FROM (
         SELECT id, (1.0 / ($6 + rank))::float8 AS weight, distance,
                NULL::bigint AS lexical_rank, NULL::real AS trigram_score
         FROM vector_hits
         UNION ALL
         SELECT id, 1.0 / ($6 + rank), NULL, rank, NULL FROM lexical_hits
         UNION ALL
         SELECT id, 1.0 / ($6 + rank), NULL, NULL, score FROM trigram_hits
       ) AS ranked
       GROUP BY id
     )
     SELECT c.id                AS "chunkId",
            d.title,
            d.source_url        AS "sourceUrl",
            d.published_at      AS "publishedAt",
            d.category,
            c.heading,
            c.text,
            (c.embedding <=> (SELECT embedding FROM parameters))::float8 AS "vectorDistance",
            f.lexical_rank      AS "lexicalRank",
            f.trigram_score::float8 AS "trigramScore",
            f.score
     FROM fused f
     JOIN chunks c ON c.id = f.id
     JOIN documents d ON d.id = c.document_id
     ORDER BY f.score DESC
     LIMIT $7`,
    [
      embedding,
      normalizedQuestion,
      category ?? null,
      CANDIDATES_PER_SEARCH,
      MIN_TITLE_SIMILARITY,
      RRF_K,
      CANDIDATES_PER_SEARCH,
      lexical,
    ],
  );
}

export type TextLookup = {
  status: "ok" | "no_match";
  hits: TextHit[];
  context: string;
};

const CATEGORY_HEADINGS: { [category: string]: string } = {
  [Category.Documentation]: "ДОКУМЕНТАЦИЈА И АДМИНИСТРАЦИЈА",
  [Category.Opportunities]: "КОНКУРСИ, СТИПЕНДИЈЕ И РАЗМЕНЕ",
};

export function formatTextContext(hits: TextHit[]): string {
  if (hits.length === 0) return "";

  const categories = [...new Set(hits.map((hit) => hit.category))];
  const heading =
    categories.length === 1
      ? (CATEGORY_HEADINGS[categories[0]] ?? "ТЕКСТУАЛНИ ИЗВОРИ")
      : "ТЕКСТУАЛНИ ИЗВОРИ";

  const blocks = hits.map((hit) => {
    const published = hit.publishedAt
      ? `, објављено ${formatDate(hit.publishedAt)}`
      : "";
    return `${hit.title}${published}\nИзвор: ${hit.sourceUrl}\n${hit.text}`;
  });

  return `${heading}:\n${blocks.join("\n\n")}`;
}

/**
 * Nijedan od tri pretrazivaca nije sam po sebi pouzdan na ovom korpusu, pa se
 * pogodak zadrzava ako ima jedan jak signal ili dva slaba koja se poklapaju.
 */
export function isRelevant(hit: TextHit): boolean {
  const distance = hit.vectorDistance ?? Number.POSITIVE_INFINITY;

  return (
    // Jak signal sam po sebi: bliska znacenjska podudarnost ili pogodjen naslov.
    distance <= STRONG_VECTOR_DISTANCE ||
    (hit.trigramScore ?? 0) >= MIN_TITLE_SIMILARITY ||
    // Inace se traze dva slaba koja se poklapaju: pogodjena rec i bliskost.
    (hit.lexicalRank !== null && distance <= SUPPORTING_VECTOR_DISTANCE)
  );
}

export async function lookupText(
  question: string,
  category: Maybe<Category> = null,
): Promise<TextLookup> {
  const hits = (await searchChunks(question, category))
    .filter(isRelevant)
    .slice(0, MAX_CHUNKS);

  return hits.length === 0
    ? { status: "no_match", hits, context: "" }
    : { status: "ok", hits, context: formatTextContext(hits) };
}
