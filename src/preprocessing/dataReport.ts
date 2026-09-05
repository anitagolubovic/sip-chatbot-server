import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import {
  buildChunks,
  cleanUnicode,
  countInvisibleCharacters,
  countTokens,
  cyrillicRatio,
  findMixedScriptWords,
  splitGluedText,
  type PreparedChunk,
} from "./index";
import { Maybe } from "../models/types";

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

type TextRecord = {
  sourceUrl: Maybe<string>;
  title: string;
  summary: Maybe<string>;
  paragraphs: string[];
};

type FileReport = {
  file: string;
  records: number;
  cyrillicRatio: number;
  mixedScriptWords: string[];
  gluedSentences: number;
  invisibleCharacters: number;
  duplicateUrls: number;
  missingTitles: number;
  tokensBefore: number;
  tokensAfter: number;
  chunks: PreparedChunk[];
};

function listDataFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) return listDataFiles(fullPath);
    return fullPath.endsWith(".json") ? [fullPath] : [];
  });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractRecords(content: Record<string, unknown>): TextRecord[] {
  if (Array.isArray(content.records)) {
    return content.records.map((raw) => {
      const record = raw as Record<string, unknown>;
      const body = (record.content ?? {}) as Record<string, unknown>;
      return {
        sourceUrl: asText(record.sourceUrl) || null,
        title: asText(record.title),
        summary: asText(record.summary) || null,
        paragraphs: asArray(body.paragraphs).map(asText),
      };
    });
  }

  if (Array.isArray(content.levels)) {
    return content.levels.map((raw) => {
      const level = raw as Record<string, unknown>;
      return {
        sourceUrl: asText(level.sourceUrl) || null,
        title: asText(level.label),
        summary: asText(level.semesterValidation) || null,
        paragraphs: [asText(level.rawText)],
      };
    });
  }

  if (Array.isArray(content.examPeriods)) {
    return content.examPeriods.flatMap((raw) => {
      const examPeriod = raw as Record<string, unknown>;
      return asArray(examPeriod.exams).map((examRaw) => {
        const exam = examRaw as Record<string, unknown>;
        return {
          sourceUrl: null,
          title: asText(exam.courseName),
          summary: null,
          paragraphs: [],
        };
      });
    });
  }

  if (Array.isArray(content.schedule)) {
    return content.schedule.map((raw) => {
      const entry = raw as Record<string, unknown>;
      return {
        sourceUrl: null,
        title: asText(entry.course),
        summary: null,
        paragraphs: [asText(entry.rawText)],
      };
    });
  }

  return [];
}

function isTextualSource(fileName: string): boolean {
  return (
    fileName.startsWith("dokumentacija") || fileName.startsWith("konkursi")
  );
}

function analyzeFile(fullPath: string): FileReport {
  const fileName = path.relative(DATA_DIR, fullPath).replace(/\\/g, "/");
  const content = JSON.parse(readFileSync(fullPath, "utf8")) as Record<
    string,
    unknown
  >;
  const records = extractRecords(content);

  const seenUrls = new Set<string>();
  const mixedScriptWords: string[] = [];
  const chunks: PreparedChunk[] = [];

  let duplicateUrls = 0;
  let missingTitles = 0;
  let gluedSentences = 0;
  let invisibleCharacters = 0;
  let tokensBefore = 0;
  let tokensAfter = 0;
  let cyrillicLetters = 0;
  let totalLetters = 0;

  for (const record of records) {
    if (record.sourceUrl) {
      if (seenUrls.has(record.sourceUrl)) duplicateUrls += 1;
      seenUrls.add(record.sourceUrl);
    }
    if (record.title.trim().length === 0) missingTitles += 1;

    const raw = [record.title, record.summary ?? "", ...record.paragraphs]
      .filter((part) => part.length > 0)
      .join("\n");

    if (raw.length === 0) continue;

    mixedScriptWords.push(...findMixedScriptWords(raw));
    invisibleCharacters += countInvisibleCharacters(raw);

    const cleaned = cleanUnicode(raw);

    gluedSentences += splitGluedText(cleaned).length - cleaned.length;

    tokensBefore += countTokens(raw);
    tokensAfter += countTokens(cleaned);

    const ratio = cyrillicRatio(raw);
    const letters = (raw.match(/\p{L}/gu) ?? []).length;
    cyrillicLetters += ratio * letters;
    totalLetters += letters;

    if (isTextualSource(fileName)) {
      chunks.push(
        ...buildChunks({
          category: asText(content.category),
          title: record.title,
          academicYear: asText(content.academicYear),
          summary: record.summary,
          paragraphs: record.paragraphs,
        }),
      );
    }
  }

  return {
    file: fileName,
    records: records.length,
    cyrillicRatio: totalLetters === 0 ? 0 : cyrillicLetters / totalLetters,
    mixedScriptWords,
    gluedSentences,
    invisibleCharacters,
    duplicateUrls,
    missingTitles,
    tokensBefore,
    tokensAfter,
    chunks,
  };
}

function formatNumber(value: number): string {
  return value.toLocaleString("sr-RS");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printFileReport(report: FileReport): void {
  const uniqueMixed = [...new Set(report.mixedScriptWords)];
  const savedTokens = report.tokensBefore - report.tokensAfter;

  console.log(`\n${report.file}`);
  console.log(`  zapisa                 ${formatNumber(report.records)}`);
  console.log(`  udeo cirilice          ${percentage(report.cyrillicRatio)}`);
  console.log(
    `  mesani skript          ${formatNumber(report.mixedScriptWords.length)}` +
      (uniqueMixed.length > 0
        ? `  npr. ${uniqueMixed.slice(0, 5).join(", ")}`
        : ""),
  );
  console.log(
    `  slepljene recenice     ${formatNumber(report.gluedSentences)}`,
  );
  console.log(
    `  nevidljivi znaci       ${formatNumber(report.invisibleCharacters)}`,
  );
  console.log(`  duplirani URL-ovi      ${formatNumber(report.duplicateUrls)}`);
  console.log(`  zapisa bez naslova     ${formatNumber(report.missingTitles)}`);
  console.log(
    `  tokeni pre/posle       ${formatNumber(report.tokensBefore)} / ` +
      `${formatNumber(report.tokensAfter)}` +
      (report.tokensBefore > 0
        ? `  (${percentage(savedTokens / report.tokensBefore)} manje)`
        : ""),
  );

  if (report.chunks.length > 0) {
    const tokenCounts = report.chunks.map((chunk) => chunk.tokenCount);
    const average =
      tokenCounts.reduce((sum, value) => sum + value, 0) / tokenCounts.length;
    console.log(
      `  cankova                ${formatNumber(report.chunks.length)}` +
        `  (prosek ${Math.round(average)}, max ${Math.max(...tokenCounts)} tokena)`,
    );
  }
}

function printSummary(reports: FileReport[]): void {
  const sum = (pick: (report: FileReport) => number): number =>
    reports.reduce((total, report) => total + pick(report), 0);

  const chunks = reports.flatMap((report) => report.chunks);
  const embeddingTokens = chunks.reduce(
    (total, chunk) => total + chunk.tokenCount,
    0,
  );

  console.log("\n" + "=".repeat(64));
  console.log("UKUPNO");
  console.log(`  fajlova                ${formatNumber(reports.length)}`);
  console.log(
    `  zapisa                 ${formatNumber(sum((r) => r.records))}`,
  );
  console.log(
    `  mesani skript          ${formatNumber(sum((r) => r.mixedScriptWords.length))}`,
  );
  console.log(
    `  slepljene recenice     ${formatNumber(sum((r) => r.gluedSentences))}`,
  );
  console.log(
    `  nevidljivi znaci       ${formatNumber(sum((r) => r.invisibleCharacters))}`,
  );
  console.log(
    `  duplirani URL-ovi      ${formatNumber(sum((r) => r.duplicateUrls))}`,
  );
  console.log(
    `  cankova za embedovanje ${formatNumber(chunks.length)}` +
      `  (${formatNumber(embeddingTokens)} tokena)`,
  );
}

function main(): void {
  const files = listDataFiles(DATA_DIR).sort();
  const reports = files.map(analyzeFile);

  const schedules = reports.filter((report) =>
    report.file.startsWith("raspored-casova/"),
  );
  const rest = reports.filter(
    (report) => !report.file.startsWith("raspored-casova/"),
  );

  rest.forEach(printFileReport);

  if (schedules.length > 0) {
    printFileReport({
      file: `raspored-casova/  (${schedules.length} fajlova, zbirno)`,
      records: schedules.reduce((total, report) => total + report.records, 0),
      cyrillicRatio:
        schedules.reduce((total, report) => total + report.cyrillicRatio, 0) /
        schedules.length,
      mixedScriptWords: schedules.flatMap((report) => report.mixedScriptWords),
      gluedSentences: schedules.reduce(
        (total, report) => total + report.gluedSentences,
        0,
      ),
      invisibleCharacters: schedules.reduce(
        (t, report) => t + report.invisibleCharacters,
        0,
      ),
      duplicateUrls: 0,
      missingTitles: schedules.reduce(
        (total, report) => total + report.missingTitles,
        0,
      ),
      tokensBefore: schedules.reduce(
        (total, report) => total + report.tokensBefore,
        0,
      ),
      tokensAfter: schedules.reduce(
        (total, report) => total + report.tokensAfter,
        0,
      ),
      chunks: [],
    });
  }

  printSummary(reports);
}

main();
