import assert from "node:assert/strict";
import test from "node:test";
import { Category, resolveCategory } from "../models/categories";
import {
  buildChunks,
  canonicalCourseNames,
  cleanUnicode,
  countTokens,
  encodingForModel,
  cyrillicToLatin,
  foldDiacritics,
  isMixedScriptWord,
  MAX_CHUNK_TOKENS,
  normalizeParagraphs,
  splitGluedText,
  splitSentences,
  toSearchForm,
} from "./index";

test("transliterates Serbian Cyrillic including digraphs", () => {
  assert.equal(cyrillicToLatin("Полагање испита"), "Polaganje ispita");
  assert.equal(cyrillicToLatin("Љубав њива џак"), "Ljubav njiva džak");
  assert.equal(cyrillicToLatin("ЉУБАВ"), "LJUBAV");
  assert.equal(cyrillicToLatin("Ђорђе Ћирић"), "Đorđe Ćirić");
});

test("leaves Latin text untouched while transliterating", () => {
  assert.equal(cyrillicToLatin("OWASP Top 10"), "OWASP Top 10");
});

test("folds Serbian diacritics to plain ASCII", () => {
  assert.equal(
    foldDiacritics("Čačak žito šuma đak ćup"),
    "Cacak zito suma djak cup",
  );
});

test("folds foreign accents the corpus may pick up later", () => {
  assert.equal(
    foldDiacritics("München Kraków Reykjavík"),
    "Munchen Krakow Reykjavik",
  );
});

test("folds decomposed input, not only precomposed", () => {
  const decomposed = "čačak"; // "cacak" as c + combining caron
  assert.equal(foldDiacritics(decomposed), "cacak");
});

test("keeps the dj digraph casing consistent", () => {
  assert.equal(foldDiacritics("Đorđe"), "Djordje");
  assert.equal(foldDiacritics("ĐORĐE"), "DJORDJE");
});

test("both scripts and a missing-diacritic typo reach the same search form", () => {
  const cyrillic = toSearchForm("Полагање испита у јануарском року");
  const latin = toSearchForm("Polaganje ispita u januarskom roku");
  const withoutDiacritics = toSearchForm("polaganje ispita u januarskom roku");

  assert.equal(cyrillic, latin);
  assert.equal(latin, withoutDiacritics);
  assert.equal(cyrillic, "polaganje ispita u januarskom roku");
});

test("course names match across scripts and spelling shortcuts", () => {
  assert.equal(toSearchForm("МАТЕМАТИКА 1"), toSearchForm("Matematika 1"));
  assert.equal(
    toSearchForm("Рачунарске мреже"),
    toSearchForm("Racunarske mreze"),
  );
  assert.equal(toSearchForm("Инжењерство"), toSearchForm("Inzenjerstvo"));
});

test("detects and repairs words that mix alphabets", () => {
  // Latin "w" welded to Cyrillic "еб" — exactly as it appears in the scraped data.
  const damaged = "wеб рањивости";

  assert.equal(isMixedScriptWord("wеб"), true);
  assert.equal(toSearchForm(damaged), "web ranjivosti");
});

test("repairs a Cyrillic look-alike inside a Latin word", () => {
  // "Autopsy" written with a Cyrillic "о" instead of Latin "o".
  assert.equal(toSearchForm("Autоpsy"), "autopsy");
});

test("leaves a word alone when its script cannot be decided", () => {
  // Only look-alikes: no evidence which alphabet was intended.
  assert.equal(cleanUnicode("ор"), "ор");
});

test("removes invisible characters and normalizes punctuation", () => {
  assert.equal(cleanUnicode("upis​semestra"), "upissemestra");
  assert.equal(cleanUnicode("«navodnici»"), '"navodnici"');
  assert.equal(cleanUnicode("crta — crta"), "crta - crta");
  assert.equal(cleanUnicode("prazno mesto"), "prazno mesto");
});

test("splits run-together sentences", () => {
  assert.equal(
    splitGluedText("iz fajlova i logovaDan 2: Mreze"),
    "iz fajlova i logova Dan 2: Mreze",
  );
  assert.equal(splitGluedText("po danima:Dan 1"), "po danima: Dan 1");
});

test("does not split short mixed-case words or URLs", () => {
  assert.equal(splitGluedText("PhD studije"), "PhD studije");
  assert.equal(
    splitGluedText("Prijava na https://sip.elfak.ni.ac.rs/Article/Upis danas"),
    "Prijava na https://sip.elfak.ni.ac.rs/Article/Upis danas",
  );
});

test("drops empty and duplicated paragraphs", () => {
  const paragraphs = normalizeParagraphs([
    "Prijava ispita.",
    "Prijava ispita.",
    "   ",
    "Overa semestra.",
  ]);

  assert.deepEqual(paragraphs, ["Prijava ispita.", "Overa semestra."]);
});

test("splits sentences without breaking on initials", () => {
  assert.deepEqual(splitSentences("Prvi rok. Drugi rok."), [
    "Prvi rok.",
    "Drugi rok.",
  ]);
  assert.deepEqual(splitSentences("Predaje M. Petrovic danas."), [
    "Predaje M. Petrovic danas.",
  ]);
});

test("counts Cyrillic as more expensive only on the older tokenizer", () => {
  // cl100k_base (gpt-4 i stariji) cepa cirilicu na vise tokena nego latinicu.
  const legacyCyrillic = countTokens("Полагање испита", "gpt-4");
  const legacyLatin = countTokens("Polaganje ispita", "gpt-4");
  assert.ok(
    legacyCyrillic > legacyLatin,
    `expected ${legacyCyrillic} > ${legacyLatin}`,
  );

  // o200k_base je tu razliku uklonio, pa izbor pisma vise ne utice na cenu.
  const cyrillic = countTokens("Полагање испита", "gpt-4o");
  const latin = countTokens("Polaganje ispita", "gpt-4o");
  assert.equal(cyrillic, latin);
});

test("keeps a short record as a single chunk", () => {
  const chunks = buildChunks({
    category: "dokumentacija",
    title: "Овера семестра",
    academicYear: "2025/2026",
    summary: "Овера се врши аутоматски.",
    paragraphs: ["Нема обавеза за студенте."],
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].ord, 0);
  assert.equal(
    chunks[0].heading,
    "[dokumentacija | Овера семестра | 2025/2026]",
  );
  assert.ok(chunks[0].text.includes("Нема обавеза"));
});

test("chunk search form carries the heading so titles stay searchable", () => {
  const [chunk] = buildChunks({
    category: "dokumentacija",
    title: "Овера семестра",
    academicYear: "2025/2026",
    paragraphs: ["Нема обавеза за студенте."],
  });

  assert.ok(chunk.textNorm.includes("overa semestra"));
  assert.ok(chunk.textNorm.includes("nema obaveza"));
});

test("splits long records into several chunks that respect the budget", () => {
  // Distinct paragraphs, because identical neighbours are intentionally deduped.
  const paragraphs = Array.from({ length: 6 }, (_unused, index) =>
    `Корак ${index + 1}. Студент подноси захтев Служби за студентска питања. `.repeat(
      12,
    ),
  );

  const chunks = buildChunks({
    category: "dokumentacija",
    title: "Дуг документ",
    academicYear: "2025/2026",
    paragraphs,
  });

  assert.ok(chunks.length > 1, "expected more than one chunk");

  chunks.forEach((chunk, index) => {
    assert.equal(chunk.ord, index);
    assert.ok(
      chunk.tokenCount <= MAX_CHUNK_TOKENS,
      `chunk ${index} has ${chunk.tokenCount} tokens`,
    );
  });
});

test("respects the budget even without sentence punctuation", () => {
  // An enumeration of the kind the scraped opportunities contain: hundreds of
  // tokens with colons but no full stop to cut on.
  const enumeration = Array.from(
    { length: 120 },
    (_unused, index) =>
      `Дан ${index + 1}: дигитална форензика и мрежна безбедност`,
  ).join(" ");

  const chunks = buildChunks({
    category: "konkursi",
    title: "Сајбер камп",
    paragraphs: [enumeration],
  });

  assert.ok(chunks.length > 1, "expected the enumeration to be split");
  chunks.forEach((chunk, index) => {
    assert.ok(
      chunk.tokenCount <= MAX_CHUNK_TOKENS,
      `chunk ${index} has ${chunk.tokenCount} tokens`,
    );
  });
});

test("falls back to the title when a record has no body", () => {
  const chunks = buildChunks({
    category: "konkursi",
    title: "Летњи камп",
    paragraphs: [],
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "Летњи камп");
});

test("normalization is idempotent", () => {
  const once = toSearchForm("Пријава испита — јануарски рок");
  assert.equal(toSearchForm(once), once);
});

test("unifies spelling variants of the same course name", () => {
  const canonical = canonicalCourseNames([
    ...Array<string>(5).fill("Ембеддед системи"),
    ...Array<string>(3).fill("Ембедед системи"),
    "Објектно-оријентисано програмирање",
    "Објектно оријентисано програмирање",
    "Објектно оријентисано програмирање",
  ]);

  // Cesci oblik postaje kanonski za obe varijante.
  assert.equal(canonical.get("Ембедед системи"), "Ембеддед системи");
  assert.equal(canonical.get("Ембеддед системи"), "Ембеддед системи");
  assert.equal(
    canonical.get("Објектно-оријентисано програмирање"),
    "Објектно оријентисано програмирање",
  );
});

test("keeps courses that differ only by an ordinal apart", () => {
  const canonical = canonicalCourseNames([
    "Математика I",
    "Математика II",
    "Енглески језик 1",
    "Енглески језик 2",
  ]);

  assert.equal(canonical.get("Математика I"), "Математика I");
  assert.equal(canonical.get("Математика II"), "Математика II");
  assert.equal(canonical.get("Енглески језик 1"), "Енглески језик 1");
  assert.equal(canonical.get("Енглески језик 2"), "Енглески језик 2");
});

test("unifies course names written in mixed scripts", () => {
  // Drugi zapis ima cirilicno "o" u "VoIP" i cirilicno "e" u "Web".
  const canonical = canonicalCourseNames(["VoIP", "VоIP", "Web", "Wеb"]);

  assert.equal(canonical.get("VоIP"), canonical.get("VoIP"));
  assert.equal(canonical.get("Wеb"), canonical.get("Web"));
});

test("picks the tokenizer that matches the model family", () => {
  assert.equal(encodingForModel("gpt-4"), "cl100k_base");
  assert.equal(encodingForModel("gpt-4-turbo"), "cl100k_base");
  assert.equal(encodingForModel("gpt-3.5-turbo"), "cl100k_base");
  assert.equal(encodingForModel("text-embedding-3-small"), "cl100k_base");

  assert.equal(encodingForModel("gpt-4o"), "o200k_base");
  assert.equal(encodingForModel("gpt-4.1"), "o200k_base");
  assert.equal(encodingForModel("gpt-5.6-luna"), "o200k_base");
  assert.equal(encodingForModel("o3-mini"), "o200k_base");

  // Nepoznat ili nedostajuci model pada na noviji enkoding.
  assert.equal(encodingForModel(null), "o200k_base");
  assert.equal(encodingForModel(""), "o200k_base");
});

test("recognizes the category the front sends, in any form", () => {
  // Slug iz podataka, naziv dugmeta i ćirilica vode na isto.
  assert.equal(resolveCategory("polaganje_ispita"), Category.ExamSchedule);
  assert.equal(resolveCategory("Polaganje ispita"), Category.ExamSchedule);
  assert.equal(resolveCategory("Полагање испита"), Category.ExamSchedule);

  assert.equal(
    resolveCategory("Kalendar aktivnosti"),
    Category.ActivityCalendar,
  );
  assert.equal(resolveCategory("Raspored časova"), Category.ClassSchedule);
  assert.equal(
    resolveCategory("Dokumentacija i administracija"),
    Category.Documentation,
  );
  assert.equal(
    resolveCategory("Stipendije, konkursi i razmene studenata"),
    Category.Opportunities,
  );

  // Bez izbora ili nepoznata vrednost znace "kategorija nije izabrana".
  assert.equal(resolveCategory(null), null);
  assert.equal(resolveCategory(""), null);
  assert.equal(resolveCategory("nesto deseto"), null);
});
