import { isDefined } from "../helper";
import { cleanUnicode } from "./unicode";

const SINGLE_LETTERS: ReadonlyMap<string, string> = new Map([
  ["а", "a"],
  ["б", "b"],
  ["в", "v"],
  ["г", "g"],
  ["д", "d"],
  ["ђ", "đ"],
  ["е", "e"],
  ["ж", "ž"],
  ["з", "z"],
  ["и", "i"],
  ["ј", "j"],
  ["к", "k"],
  ["л", "l"],
  ["м", "m"],
  ["н", "n"],
  ["о", "o"],
  ["п", "p"],
  ["р", "r"],
  ["с", "s"],
  ["т", "t"],
  ["ћ", "ć"],
  ["у", "u"],
  ["ф", "f"],
  ["х", "h"],
  ["ц", "c"],
  ["ч", "č"],
  ["ш", "š"],
]);

const DIGRAPHS: ReadonlyMap<string, string> = new Map([
  ["љ", "lj"],
  ["њ", "nj"],
  ["џ", "dž"],
]);

/**
 * Combining marks left behind by canonical decomposition — the caron on č/ć/š/ž
 * and any accent a foreign name brings with it.
 */
const COMBINING_MARKS = /[\u0300-\u036F]/g;

/**
 * "đ" is its own code point (U+0111) rather than "d" plus a mark, so canonical
 * decomposition does not touch it. It has to be rewritten before the general
 * folding, and it becomes "dj" rather than "d" because that is what a student
 * actually types: "djak", never "dak".
 */
const D_WITH_STROKE = /[đĐ]/g;

const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u;

function isUpperCase(character: string): boolean {
  return character !== character.toLowerCase();
}

function transliterateDigraph(
  latin: string,
  nextCharacter: string | undefined,
): string {
  const nextIsUpperCase =
    nextCharacter !== undefined &&
    CYRILLIC_LETTER.test(nextCharacter) &&
    isUpperCase(nextCharacter);

  return nextIsUpperCase
    ? latin.toUpperCase()
    : latin.charAt(0).toUpperCase() + latin.slice(1);
}

export function cyrillicToLatin(text: string): string {
  if (!text) return "";

  const characters = [...text];

  return characters
    .map((character, index) => {
      const lowerCased = character.toLowerCase();

      const digraph = DIGRAPHS.get(lowerCased);
      if (isDefined(digraph)) {
        return isUpperCase(character)
          ? transliterateDigraph(digraph, characters[index + 1])
          : digraph;
      }

      const single = SINGLE_LETTERS.get(lowerCased);
      if (single !== undefined) {
        return isUpperCase(character) ? single.toUpperCase() : single;
      }

      return character;
    })
    .join("");
}

/**
 * Removes diacritics: "č" and "ć" both become "c", "đ" becomes "dj". Applied
 * after transliteration, so it covers text that was originally Cyrillic as well
 * as text the student typed in Latin.
 *
 * Canonical decomposition does the work instead of a fixed table, which also
 * folds accents this corpus does not have yet — foreign names in exchange and
 * scholarship announcements, and whatever the student happens to type.
 */
export function foldDiacritics(text: string): string {
  if (!text) return "";

  const withoutStroke = text.replace(D_WITH_STROKE, (match, offset: number) => {
    if (match === "đ") return "dj";

    // Upper case "Đ" follows the same rule as the Cyrillic digraphs:
    // "ĐORĐE" becomes "DJORDJE", but "Đorđe" becomes "Djordje".
    const next = text[offset + 1];
    return isDefined(next) && isUpperCase(next) ? "DJ" : "Dj";
  });

  return withoutStroke.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
}

export function toSearchForm(text: string): string {
  if (!text) return "";

  return foldDiacritics(cyrillicToLatin(cleanUnicode(text)))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function cyrillicRatio(text: string): number {
  let cyrillic = 0;
  let letters = 0;

  for (const character of text) {
    if (!/\p{L}/u.test(character)) continue;
    letters += 1;
    if (CYRILLIC_LETTER.test(character)) cyrillic += 1;
  }

  return letters === 0 ? 0 : cyrillic / letters;
}
