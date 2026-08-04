import { pathToFileURL } from "url";
import type { Canvas } from "@napi-rs/canvas";

export type TextItem = {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  angleDeg: number;
};

export type Shape = {
  fill: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
};

export type LoadedPage = {
  width: number;
  height: number;
  textItems: TextItem[];
  shapes: Shape[];
  render(scale: number): Promise<Canvas>;
};

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

const importEsm = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<PdfjsModule>;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    const entry = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsPromise = importEsm(pathToFileURL(entry).href);
  }
  return pdfjsPromise;
}

function normalizeMatrix(value: unknown): number[] {
  return Array.from(value as ArrayLike<number>, Number).slice(0, 6);
}

function multiplyMatrix(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function applyMatrix(
  ctm: number[],
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: ctm[0] * x + ctm[2] * y + ctm[4],
    y: ctm[1] * x + ctm[3] * y + ctm[5],
  };
}

function collectSubpathPoints(
  subpath: ArrayLike<number>,
  ctm: number[],
  xs: number[],
  ys: number[],
): void {
  const values = Array.from(subpath, Number);
  let index = 0;

  while (index < values.length) {
    const code = values[index];
    if (code === 4) {
      index += 1;
      continue;
    }

    const coordinateCount = code === 2 || code === 3 ? 6 : 2;
    for (let offset = 0; offset < coordinateCount; offset += 2) {
      const x = values[index + 1 + offset];
      const y = values[index + 2 + offset];
      if (x === undefined || y === undefined) {
        break;
      }
      const point = applyMatrix(ctm, x, y);
      xs.push(point.x);
      ys.push(point.y);
    }
    index += 1 + coordinateCount;
  }
}

export async function loadPage(pdf: Buffer): Promise<LoadedPage> {
  const pdfjs = await loadPdfjs();
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: true,
  }).promise;
  const page = await document.getPage(1);
  const viewport = page.getViewport({ scale: 1 });

  const textContent = await page.getTextContent();
  const textItems: TextItem[] = [];
  for (const item of textContent.items) {
    if (!("str" in item) || !item.str.trim()) {
      continue;
    }
    const transform = item.transform as number[];
    const x = transform[4];
    const y = transform[5];
    textItems.push({
      text: item.str,
      x0: x,
      x1: x + item.width,
      y0: y,
      y1: y + item.height,
      angleDeg: (Math.atan2(transform[1], transform[0]) * 180) / Math.PI,
    });
  }

  const operators = await page.getOperatorList();
  const opNames: Record<number, string> = {};
  for (const [name, code] of Object.entries(pdfjs.OPS)) {
    opNames[code as number] = name;
  }

  const shapes: Shape[] = [];
  const stack: { fill: string; ctm: number[] }[] = [];
  let fill = "#000000";
  let ctm = [1, 0, 0, 1, 0, 0];

  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const operator = opNames[operators.fnArray[index]];
    const args = operators.argsArray[index] as unknown[];

    if (operator === "save") {
      stack.push({ fill, ctm });
    } else if (operator === "restore") {
      const restored = stack.pop();
      if (restored) {
        fill = restored.fill;
        ctm = restored.ctm;
      }
    } else if (operator === "transform") {
      ctm = multiplyMatrix(normalizeMatrix(args), ctm);
    } else if (operator === "setFillRGBColor") {
      fill = String(args[0]).toLowerCase();
    } else if (operator === "constructPath") {
      const rawSubpaths = args[1];
      const subpaths = (
        Array.isArray(rawSubpaths) ? rawSubpaths : [rawSubpaths]
      ) as ArrayLike<number>[];
      const xs: number[] = [];
      const ys: number[] = [];
      for (const subpath of subpaths) {
        if (subpath) {
          collectSubpathPoints(subpath, ctm, xs, ys);
        }
      }
      if (xs.length > 0) {
        shapes.push({
          fill,
          x0: Math.min(...xs),
          x1: Math.max(...xs),
          y0: Math.min(...ys),
          y1: Math.max(...ys),
        });
      }
    }
  }

  return {
    width: viewport.width,
    height: viewport.height,
    textItems,
    shapes,
    async render(scale: number): Promise<Canvas> {
      const { createCanvas } = await import("@napi-rs/canvas");
      const scaled = page.getViewport({ scale });
      const canvas = createCanvas(scaled.width, scaled.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, scaled.width, scaled.height);
      await page.render({
        canvasContext: context,
        viewport: scaled,
        intent: "print",
      } as unknown as Parameters<typeof page.render>[0]).promise;
      return canvas;
    },
  };
}
