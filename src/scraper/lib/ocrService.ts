//vertikalni sadrzaj rasporeda

import type { Canvas } from "@napi-rs/canvas";
import { createWorker, type Worker } from "tesseract.js";

export type OcrResult = {
  text: string;
  confidence: number;
};

let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("srp", 1, { logger: () => undefined });

      await worker.setParameters({ tessedit_pageseg_mode: "6" as never });
      return worker;
    })();
  }
  return workerPromise;
}

export async function terminateOcr(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

export async function recognizeRotatedRegion(
  pageCanvas: Canvas,
  region: { x0: number; x1: number; y0: number; y1: number },
  pageHeight: number,
  scale: number,
): Promise<OcrResult> {
  const { createCanvas } = await import("@napi-rs/canvas");

  const sourceX = Math.round(region.x0 * scale);
  const sourceY = Math.round((pageHeight - region.y1) * scale);
  const sourceWidth = Math.max(1, Math.round((region.x1 - region.x0) * scale));
  const sourceHeight = Math.max(1, Math.round((region.y1 - region.y0) * scale));

  const upright = createCanvas(sourceHeight, sourceWidth);
  const context = upright.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, sourceHeight, sourceWidth);
  context.translate(sourceHeight, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(
    pageCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  const worker = await getWorker();
  const { data } = await worker.recognize(upright.toBuffer("image/png"));
  return {
    text: cleanRecognizedText(data.text),
    confidence: data.confidence,
  };
}

function cleanRecognizedText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[|¦!]/g, " ")
    .replace(/^[\s,.;:_"'`~^-]+/, "")
    .replace(/[\s,.;:_"'`~^]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function unifyCourseNames<
  T extends { course: string; fromOcr: boolean },
>(entries: T[]): number {
  const weights = new Map<string, number>();
  for (const entry of entries) {
    const weight = entry.fromOcr ? 1 : 10;
    weights.set(entry.course, (weights.get(entry.course) ?? 0) + weight);
  }

  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const digits = (value: string): string => value.replace(/\D/g, "");
  const canonical = new Map<string, string>();

  for (const [name] of ranked) {
    const folded = name.toUpperCase();
    let chosen = name;
    for (const [candidate, weight] of ranked) {
      if (candidate === name || digits(candidate) !== digits(name)) {
        continue;
      }
      if (weight <= (weights.get(chosen) ?? 0)) {
        continue;
      }
      const tolerance = Math.max(2, Math.floor(candidate.length * 0.25));
      if (levenshtein(folded, candidate.toUpperCase()) <= tolerance) {
        chosen = candidate;
      }
    }
    canonical.set(name, chosen);
  }

  let changed = 0;
  for (const entry of entries) {
    const replacement = canonical.get(entry.course);
    if (replacement && replacement !== entry.course) {
      entry.course = replacement;
      changed += 1;
    }
  }
  return changed;
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = previous[j];
      previous[j] =
        a[i - 1] === b[j - 1]
          ? diagonal
          : 1 + Math.min(diagonal, previous[j], previous[j - 1]);
      diagonal = current;
    }
  }
  return previous[b.length];
}

export function snapToLexicon(
  name: string,
  lexicon: Iterable<string>,
): { name: string; corrected: boolean } {
  const folded = name.toUpperCase();
  const digits = (value: string): string => value.replace(/\D/g, "");

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of lexicon) {
    if (digits(candidate) !== digits(name)) {
      continue;
    }
    if (candidate.toUpperCase() === folded) {
      return { name: candidate, corrected: candidate !== name };
    }
    const distance = levenshtein(folded, candidate.toUpperCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  if (best === null) {
    return { name, corrected: false };
  }

  const tolerance = Math.max(1, Math.floor(best.length / 8));
  return bestDistance <= tolerance
    ? { name: best, corrected: true }
    : { name, corrected: false };
}
