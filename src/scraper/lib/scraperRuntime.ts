import fs from "node:fs";
import path from "node:path";
import { normalizeAcademicYear } from "./documentationParser";

export const DATA_DIR = path.join(__dirname, "..", "..", "..", "data");

export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

export function academicYearSlug(academicYear: string): string {
  return academicYear.replace("/", "-");
}

export function requireAcademicYear(
  value: string | undefined,
  command: string,
): string {
  if (!value) {
    throw new Error(
      `Skolska godina je obavezna. Primer: npm run ${command} -- "2025/2026".`,
    );
  }
  const academicYear = normalizeAcademicYear(value);
  if (!academicYear) {
    throw new Error(
      `Neispravna skolska godina "${value}". Ocekivan oblik je 2025/2026.`,
    );
  }
  return academicYear;
}

export function currentAcademicYear(date = new Date()): string {
  const year = date.getFullYear();
  const start = date.getMonth() + 1 >= 10 ? year : year - 1;
  return `${start}/${start + 1}`;
}

export function paginatedUrl(url: string, page: number): string {
  if (page === 1) return url;
  const result = new URL(url);
  result.searchParams.set("page", String(page));
  return result.toString();
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

export function runCli(task: () => Promise<void>, errorLabel: string): void {
  task().catch((error: unknown) => {
    console.error(
      errorLabel,
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
