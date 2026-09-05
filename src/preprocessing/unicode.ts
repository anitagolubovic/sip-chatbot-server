const CYRILLIC_TO_LATIN_LOOKALIKE: ReadonlyMap<string, string> = new Map([
  ["А", "A"],
  ["В", "B"],
  ["Е", "E"],
  ["К", "K"],
  ["М", "M"],
  ["Н", "H"],
  ["О", "O"],
  ["Р", "P"],
  ["С", "C"],
  ["Т", "T"],
  ["У", "Y"],
  ["Х", "X"],
  ["Ј", "J"],
  ["Ѕ", "S"],
  ["І", "I"],
  ["а", "a"],
  ["е", "e"],
  ["о", "o"],
  ["р", "p"],
  ["с", "c"],
  ["у", "y"],
  ["х", "x"],
  ["ј", "j"],
  ["ѕ", "s"],
  ["і", "i"],
]);

const LATIN_TO_CYRILLIC_LOOKALIKE: ReadonlyMap<string, string> = new Map(
  [...CYRILLIC_TO_LATIN_LOOKALIKE].map(([cyrillic, latin]) => [
    latin,
    cyrillic,
  ]),
);

const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;

const EXOTIC_WHITESPACE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const PUNCTUATION_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″«»]/g, '"'],
  [/[‐-―−]/g, "-"],
  [/…/g, "..."],
];

export function isMixedScriptWord(word: string): boolean {
  let hasCyrillic = false;
  let hasLatin = false;

  for (const character of word) {
    if (CYRILLIC_LETTER.test(character)) hasCyrillic = true;
    else if (LATIN_LETTER.test(character)) hasLatin = true;
  }

  return hasCyrillic && hasLatin;
}

function countUnambiguousLetters(word: string): {
  cyrillic: number;
  latin: number;
} {
  let cyrillic = 0;
  let latin = 0;

  for (const character of word) {
    if (CYRILLIC_TO_LATIN_LOOKALIKE.has(character)) continue;
    if (LATIN_TO_CYRILLIC_LOOKALIKE.has(character)) continue;
    if (CYRILLIC_LETTER.test(character)) cyrillic += 1;
    else if (LATIN_LETTER.test(character)) latin += 1;
  }

  return { cyrillic, latin };
}

export function normalizeMixedScript(text: string): string {
  return text.replace(/\p{L}+/gu, (word) => {
    if (!isMixedScriptWord(word)) return word;

    const { cyrillic, latin } = countUnambiguousLetters(word);

    if (cyrillic > 0 && latin === 0) {
      return [...word]
        .map(
          (character) =>
            LATIN_TO_CYRILLIC_LOOKALIKE.get(character) ?? character,
        )
        .join("");
    }

    if (latin > 0 && cyrillic === 0) {
      return [...word]
        .map(
          (character) =>
            CYRILLIC_TO_LATIN_LOOKALIKE.get(character) ?? character,
        )
        .join("");
    }

    return word;
  });
}

export function findMixedScriptWords(text: string): string[] {
  return (text.match(/\p{L}+/gu) ?? []).filter(isMixedScriptWord);
}

export function countInvisibleCharacters(text: string): number {
  return (text.match(INVISIBLE_CHARACTERS) ?? []).length;
}

export function cleanUnicode(text: string): string {
  if (!text) return "";

  return normalizeMixedScript(text.normalize("NFC"))
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(EXOTIC_WHITESPACE, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      PUNCTUATION_REPLACEMENTS.reduce(
        (accumulated, [pattern, replacement]) =>
          accumulated.replace(pattern, replacement),
        line,
      )
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .join("\n");
}
