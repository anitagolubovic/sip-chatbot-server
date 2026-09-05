import { Maybe } from "../models/types";

export type StudyLevelFilter = "osnovne_akademske" | "master_akademske";

export const STUDY_LEVEL_LABELS: { [level: string]: string } = {
  osnovne_akademske: "основне академске студије",
  master_akademske: "мастер академске студије",
};

/** Danasnji datum u lokalnoj zoni; toISOString bi kod nas vratio prethodni dan. */
export function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function detectStudyLevel(
  normalizedQuestion: string,
): Maybe<StudyLevelFilter> {
  if (/\bmaster|\bmas\b|masterskim/.test(normalizedQuestion)) {
    return "master_akademske";
  }
  if (/\bosnovn|\boas\b/.test(normalizedQuestion)) {
    return "osnovne_akademske";
  }
  return null;
}

export function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${Number(day)}.${Number(month)}.${year}.`;
}

/** "od 3.11.2025. do 13.2.2026." — izostavlja polovinu koje nema. */
export function formatRange(
  from: Maybe<string>,
  to: Maybe<string>,
): Maybe<string> {
  if (from && to) return `од ${formatDate(from)} до ${formatDate(to)}`;
  if (from) return `од ${formatDate(from)}`;
  if (to) return `до ${formatDate(to)}`;
  return null;
}
