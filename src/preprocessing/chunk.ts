import { Maybe } from "../models/types";
import { normalizeParagraphs, splitSentences } from "./segment";
import { countTokens } from "./tokens";
import { toSearchForm } from "./transliterate";

export const MAX_CHUNK_TOKENS = 400;
export const OVERLAP_SENTENCES = 1;

export type ChunkSource = {
  category: string;
  title: string;
  academicYear?: Maybe<string>;
  summary?: Maybe<string>;
  paragraphs?: Maybe<readonly string[]>;
};

export type PreparedChunk = {
  ord: number;
  heading: string;
  text: string;
  textNorm: string;
  tokenCount: number;
};

export function buildHeading(source: ChunkSource): string {
  const parts = [source.category, source.title, source.academicYear].filter(
    (part): part is string =>
      typeof part === "string" && part.trim().length > 0,
  );

  return `[${parts.map((part) => part.trim()).join(" | ")}]`;
}

function splitByWords(text: string, budget: number): string[] {
  const words = text.split(" ").filter((word) => word.length > 0);
  const groups: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    const candidate = [...current, word].join(" ");

    if (current.length > 0 && countTokens(candidate) > budget) {
      groups.push(current.join(" "));
      current = [word];
      continue;
    }

    current.push(word);
  }

  if (current.length > 0) groups.push(current.join(" "));

  return groups.length > 0 ? groups : [text];
}

function splitOversizedParagraph(paragraph: string, budget: number): string[] {
  const sentences = splitSentences(paragraph);
  const groups: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    groups.push(current.join(" "));
    current = [];
  };

  for (const sentence of sentences) {
    if (countTokens(sentence) > budget) {
      flush();
      groups.push(...splitByWords(sentence, budget));
      continue;
    }

    const candidate = [...current, sentence].join(" ");

    if (current.length > 0 && countTokens(candidate) > budget) {
      flush();
    }

    current.push(sentence);
  }

  flush();

  return groups.length > 0 ? groups : splitByWords(paragraph, budget);
}

function toUnits(paragraphs: readonly string[], budget: number): string[] {
  return paragraphs.flatMap((paragraph) =>
    countTokens(paragraph) <= budget
      ? [paragraph]
      : splitOversizedParagraph(paragraph, budget),
  );
}

function overlapFrom(text: string): string {
  const sentences = splitSentences(text);
  return sentences.slice(-OVERLAP_SENTENCES).join(" ");
}

export function buildChunks(source: ChunkSource): PreparedChunk[] {
  const heading = buildHeading(source);
  const budget = MAX_CHUNK_TOKENS - countTokens(heading);

  const paragraphs = normalizeParagraphs([
    source.summary ?? "",
    ...(source.paragraphs ?? []),
  ]);

  const content = paragraphs.length > 0 ? paragraphs : [source.title];
  const units = toUnits(content, budget);

  const bodies: string[] = [];
  let current: string[] = [];

  for (const unit of units) {
    const candidate = [...current, unit].join("\n\n");

    if (current.length > 0 && countTokens(candidate) > budget) {
      const finished = current.join("\n\n");
      bodies.push(finished);

      const overlap = overlapFrom(finished);
      const startsWithOverlap =
        overlap.length > 0 && countTokens(`${overlap}\n\n${unit}`) <= budget;

      current = startsWithOverlap ? [overlap, unit] : [unit];
      continue;
    }

    current.push(unit);
  }

  if (current.length > 0) bodies.push(current.join("\n\n"));

  return bodies.map((text, ord) => ({
    ord,
    heading,
    text,
    textNorm: toSearchForm(`${heading} ${text}`),
    tokenCount: countTokens(`${heading}\n${text}`),
  }));
}
