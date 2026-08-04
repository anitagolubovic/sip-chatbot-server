import type { Shape, TextItem } from "./pdfPageLoader";
import type { TableBox } from "./scheduleGrid";

export type ClassType =
  | "predavanje"
  | "racunske_vezbe"
  | "laboratorijske_vezbe"
  | "ostali_casovi";

export type Legend = {
  lectureFill: string;
  hasLabEntry: boolean;
  labels: string[];
};

const LECTURE_LABEL = /предавања/i;
const EXERCISE_LABEL = /рачунске\s*вежбе/i;
const LAB_LABEL = /лаборато/i;

function normalize(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function isNeutral(fill: string): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(fill);
  if (!match) {
    return false;
  }
  const [red, green, blue] = match.slice(1).map((part) => parseInt(part, 16));
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  return max - min < 24;
}

export function isBackgroundFill(fill: string): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(fill);
  if (!match) {
    return false;
  }
  const channels = match.slice(1).map((part) => parseInt(part, 16));
  return channels.every((value) => value > 235);
}

export function parseLegend(
  textItems: TextItem[],
  shapes: Shape[],
  table: TableBox,
): Legend {
  const below = textItems.filter((item) => item.y1 < table.y0);
  const labels = below.map((item) => normalize(item.text));
  const joined = labels.join(" ");

  const lectureItem = below.find((item) =>
    LECTURE_LABEL.test(normalize(item.text)),
  );
  if (!lectureItem) {
    throw new Error(
      'U legendi ispod tabele nije pronadjena stavka "ПРЕДАВАЊА".',
    );
  }

  const centerX = (lectureItem.x0 + lectureItem.x1) / 2;
  const centerY = (lectureItem.y0 + lectureItem.y1) / 2;
  const swatch = shapes.find(
    (shape) =>
      shape.y1 < table.y0 &&
      !isBackgroundFill(shape.fill) &&
      shape.fill !== "#000000" &&
      isNeutral(shape.fill) &&
      shape.x0 <= centerX &&
      shape.x1 >= centerX &&
      shape.y0 <= centerY &&
      shape.y1 >= centerY,
  );

  if (!swatch) {
    throw new Error(
      'Natpis "ПРЕДАВАЊА" u legendi nije na obojenoj podlozi - ' +
        "kodiranje tipova nastave se promenilo.",
    );
  }

  if (!EXERCISE_LABEL.test(joined)) {
    throw new Error('U legendi nije pronadjena stavka "РАЧУНСКЕ ВЕЖБЕ".');
  }

  return {
    lectureFill: swatch.fill,
    hasLabEntry: LAB_LABEL.test(joined),
    labels: [...new Set(labels)],
  };
}
