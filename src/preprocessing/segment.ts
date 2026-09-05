import { cleanUnicode } from "./unicode";

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const MASK_START = "\u0000";
const MASK_END = "\u0001";
const MASK_PATTERN = /\u0000(\d+)\u0001/g;

const PUNCTUATION_GLUED_TO_CAPITAL = /([.,:;!?])(\p{Lu})/gu;

const WORD_GLUED_TO_CAPITAL = /(\p{Ll}{2,})(\p{Lu})/gu;

const INITIAL_BEFORE_NAME = /\b(\p{Lu})\.\s+(?=\p{Lu})/gu;
const NON_BREAKING_SPACE = "\u00A0";

export function splitGluedText(text: string): string {
  if (!text) return "";

  const urls: string[] = [];
  const masked = text.replace(URL_PATTERN, (url) => {
    urls.push(url);
    return `${MASK_START}${urls.length - 1}${MASK_END}`;
  });

  const repaired = masked
    .replace(PUNCTUATION_GLUED_TO_CAPITAL, "$1 $2")
    .replace(WORD_GLUED_TO_CAPITAL, "$1 $2")
    .replace(/ {2,}/g, " ");

  return repaired.replace(
    MASK_PATTERN,
    (_match, index: string) => urls[Number(index)] ?? "",
  );
}

export function normalizeParagraphs(
  input: string | readonly string[],
): string[] {
  const rawParagraphs = Array.isArray(input)
    ? [...(input as readonly string[])]
    : String(input).split(/\n{2,}/);

  const paragraphs: string[] = [];

  for (const raw of rawParagraphs) {
    const cleaned = splitGluedText(cleanUnicode(String(raw ?? "")))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(" ")
      .trim();

    if (cleaned.length === 0) continue;
    if (paragraphs[paragraphs.length - 1] === cleaned) continue;

    paragraphs.push(cleaned);
  }

  return paragraphs;
}

export function splitSentences(text: string): string[] {
  if (!text) return [];

  const withProtectedInitials = text.replace(
    INITIAL_BEFORE_NAME,
    `$1.${NON_BREAKING_SPACE}`,
  );

  return withProtectedInitials
    .split(/(?<=[.!?])[ \t\n]+(?=\p{Lu}|\d)/u)
    .map((sentence) => sentence.split(NON_BREAKING_SPACE).join(" ").trim())
    .filter((sentence) => sentence.length > 0);
}
