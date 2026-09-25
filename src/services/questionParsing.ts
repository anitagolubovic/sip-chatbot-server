import { Maybe } from "../models/types";

export type StudyLevelFilter = "osnovne_akademske" | "master_akademske";

export const STUDY_LEVEL_LABELS: { [level: string]: string } = {
  osnovne_akademske: "основне академске студије",
  master_akademske: "мастер академске студије",
};

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

// Pitanje trazi odredjenu vrstu nastave: vraca tipove koji se prikazuju, ili
// null kada vrsta nije pomenuta pa treba prikazati ceo raspored predmeta.
export function detectClassTypes(
  normalizedQuestion: string,
): Maybe<string[]> {
  if (/racunsk\w*\s*vezb|\brv\b/.test(normalizedQuestion)) {
    return ["racunske_vezbe"];
  }
  if (/laborator\w*\s*vezb|\blab\b|\blv\b/.test(normalizedQuestion)) {
    return ["laboratorijske_vezbe"];
  }
  if (/predavanj/.test(normalizedQuestion)) {
    return ["predavanje"];
  }
  // Same "vezbe" ne razlikuju racunske od laboratorijskih.
  if (/vezb/.test(normalizedQuestion)) {
    return ["racunske_vezbe", "laboratorijske_vezbe"];
  }
  return null;
}

export function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${Number(day)}.${Number(month)}.${year}.`;
}

export function formatRange(
  from: Maybe<string>,
  to: Maybe<string>,
): Maybe<string> {
  if (from && to) return `од ${formatDate(from)} до ${formatDate(to)}`;
  if (from) return `од ${formatDate(from)}`;
  if (to) return `до ${formatDate(to)}`;
  return null;
}
