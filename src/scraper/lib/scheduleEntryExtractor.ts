import type { Canvas } from "@napi-rs/canvas";
import type { Shape, TextItem } from "./pdfPageLoader";
import {
  isDayName,
  type DayColumn,
  type Grid,
  type TimeRow,
} from "./scheduleGrid";
import {
  isBackgroundFill,
  type ClassType,
  type Legend,
} from "./scheduleLegend";
import {
  recognizeRotatedRegion,
  snapToLexicon,
  unifyCourseNames,
} from "./ocrService";

export type Region = {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  fill: string;
  dashed: boolean;
};

export type ScheduleEntry = {
  day: DayColumn["day"];
  startsAt: string;
  endsAt: string;
  classType: ClassType;
  course: string;
  group: string | null;
  room: string | null;
  fromOcr: boolean;
  ocrConfidence?: number;
  rawText: string;
};

type Line = {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  slot: number;
};

const MIN_REGION_SIZE = 3;
const GLYPH_MIN_SIZE = 1.5;
const GLYPH_MAX_SIZE = 15;
const MIN_GLYPHS_FOR_TEXT = 5;
const OCR_SCALE = 6;
const OCR_PADDING = 1.5;
const LOW_CONFIDENCE = 60;

const OTHER_LABELS = /^(колоквијуми|остали|испити|пријем)/i;

function normalize(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function overlaps(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function composeLine(items: TextItem[]): string {
  const sorted = [...items].sort((a, b) => a.x0 - b.x0);
  const widths = sorted
    .map((item) => (item.x1 - item.x0) / Math.max(1, item.text.length))
    .filter((width) => width > 0.1)
    .sort((a, b) => a - b);
  const unit = widths[Math.floor(widths.length / 2)] || 1;
  const originX = sorted[0].x0;

  const buffer: string[] = [];
  let previous: TextItem | null = null;

  for (const item of sorted) {
    if (previous && item.x0 < previous.x1 - 0.5) {
      const start = Math.max(0, Math.round((item.x0 - originX) / unit));
      for (let index = 0; index < item.text.length; index += 1) {
        const position = start + index;
        const character = item.text[index];

        if (character === " " && buffer[position] && buffer[position] !== " ") {
          continue;
        }
        buffer[position] = character;
      }
    } else {
      if (previous && item.x0 - previous.x1 > unit * 0.25) {
        buffer.push(" ");
      }
      for (const character of item.text) {
        buffer.push(character);
      }
    }

    if (!previous || item.x1 > previous.x1) {
      previous = item;
    }
  }

  return normalize(buffer.map((character) => character ?? " ").join(""));
}

function contains(
  region: { x0: number; x1: number; y0: number; y1: number },
  x: number,
  y: number,
): boolean {
  return (
    x >= region.x0 - 1 && x <= region.x1 + 1 && y >= region.y0 && y <= region.y1
  );
}

function regionAt(regions: Region[], x: number, y: number): number {
  let best = -1;
  for (let index = 0; index < regions.length; index += 1) {
    if (!contains(regions[index], x, y)) {
      continue;
    }
    if (
      best === -1 ||
      regions[index].x1 - regions[index].x0 <
        regions[best].x1 - regions[best].x0
    ) {
      best = index;
    }
  }
  return best;
}

export function composeTextLines(items: TextItem[]): string[] {
  const groups: TextItem[][] = [];

  for (const item of [...items].sort((a, b) => b.y0 - a.y0)) {
    const group = groups.find((candidate) =>
      candidate.some(
        (member) =>
          Math.abs(member.y0 - item.y0) < 4 &&
          overlaps(member.y0, member.y1, item.y0, item.y1) > 0,
      ),
    );
    if (group) {
      group.push(item);
    } else {
      groups.push([item]);
    }
  }

  return groups.map((group) => composeLine(group)).filter(Boolean);
}

function buildLines(items: TextItem[], regions: Region[]): Line[] {
  const groups: { slot: number; items: TextItem[] }[] = [];

  for (const item of [...items].sort((a, b) => b.y0 - a.y0)) {
    const slot = regionAt(
      regions,
      (item.x0 + item.x1) / 2,
      (item.y0 + item.y1) / 2,
    );
    const group = groups.find(
      (candidate) =>
        candidate.slot === slot &&
        candidate.items.some(
          (member) =>
            Math.abs(member.y0 - item.y0) < 4 &&
            overlaps(member.y0, member.y1, item.y0, item.y1) > 0,
        ),
    );
    if (group) {
      group.items.push(item);
    } else {
      groups.push({ slot, items: [item] });
    }
  }

  return groups.map(({ slot, items: group }) => ({
    text: composeLine(group),
    x0: Math.min(...group.map((item) => item.x0)),
    x1: Math.max(...group.map((item) => item.x1)),
    y0: Math.min(...group.map((item) => item.y0)),
    y1: Math.max(...group.map((item) => item.y1)),
    slot,
  }));
}

function hasDashedBorder(
  region: { x0: number; x1: number; y0: number; y1: number },
  blackShapes: Shape[],
): boolean {
  const segments = blackShapes.filter(
    (shape) =>
      shape.y1 - shape.y0 < 4 &&
      shape.x0 >= region.x0 - 2 &&
      shape.x1 <= region.x1 + 2 &&
      shape.x1 - shape.x0 < (region.x1 - region.x0) * 0.6 &&
      Math.abs((shape.y0 + shape.y1) / 2 - region.y1) < 3,
  );
  return segments.length >= 3;
}

function findRegions(
  shapes: Shape[],
  blackShapes: Shape[],
  grid: Grid,
  column: DayColumn,
): Region[] {
  return shapes
    .filter(
      (shape) =>
        shape.fill !== "#000000" &&
        shape.x1 - shape.x0 > MIN_REGION_SIZE &&
        shape.y1 - shape.y0 > MIN_REGION_SIZE &&
        shape.y0 >= grid.table.y0 - 2 &&
        shape.y1 <= grid.table.y1 + 2 &&
        overlaps(shape.x0, shape.x1, column.x0, column.x1) >
          (shape.x1 - shape.x0) * 0.5,
    )
    .map((shape) => ({
      x0: shape.x0,
      x1: shape.x1,
      y0: shape.y0,
      y1: shape.y1,
      fill: shape.fill,
      dashed: hasDashedBorder(shape, blackShapes),
    }));
}

function classifyRegion(region: Region, legend: Legend): ClassType {
  if (region.fill === legend.lectureFill) {
    return "predavanje";
  }
  if (region.dashed && legend.hasLabEntry) {
    return "laboratorijske_vezbe";
  }
  if (isBackgroundFill(region.fill)) {
    return "racunske_vezbe";
  }
  return "ostali_casovi";
}

export function parseCellText(lines: string[]): {
  course: string;
  group: string | null;
  room: string | null;
} {
  const text = normalize(lines.join(" "));

  const roomMatches = [
    ...text.matchAll(
      /\(\s*([0-9A-Za-zА-Яа-яЂђЈјЉљЊњЋћЏџ][0-9A-Za-zА-Яа-яЂђЈјЉљЊњЋћЏџ /.-]{0,15}?)\s*\)/g,
    ),
  ];
  const room =
    roomMatches.length > 0
      ? normalize(roomMatches[roomMatches.length - 1][1])
      : null;

  const groupPattern = /(?:^|\s)[-–—]\s*([^-–—]{1,40}?)\s*[-–—](?=\s|$)/;
  const groupMatch = groupPattern.exec(text);
  const groupToken = groupMatch ? normalize(groupMatch[1]) : null;
  const isGroupList =
    groupToken !== null &&
    /^[\p{L}\d]{1,3}(\s*,\s*[\p{L}\d]{1,3})+$/u.test(groupToken);
  const group =
    groupToken && (/^\d{1,2}$/.test(groupToken) || isGroupList)
      ? groupToken
      : null;

  const course = normalize(
    text
      .replace(/\([^()]*\)/g, " ")
      .replace(new RegExp(groupPattern.source, "g"), " ")
      .replace(/\s[-–—]+\s*$/, " ")
      .replace(/(?:^|\s)[,;:.'"`~^_]+(?=\s|$)/g, " "),
  );

  return { course, group, room };
}

function rowsForCell(
  regions: Region[],
  timeRows: TimeRow[],
): { row: TimeRow; region: Region }[] {
  const result: { row: TimeRow; region: Region }[] = [];

  for (const row of timeRows) {
    let best: Region | null = null;
    let bestOverlap = 0;
    for (const region of regions) {
      const amount = overlaps(region.y0, region.y1, row.y0, row.y1);
      if (amount > bestOverlap) {
        bestOverlap = amount;
        best = region;
      }
    }
    if (best && bestOverlap > (row.y1 - row.y0) * 0.5) {
      result.push({ row, region: best });
    }
  }

  return result;
}

type Cell = {
  regions: Region[];
  lines: Line[];
};

function buildBlocks(lines: Line[]): Line[][] {
  const parent = lines.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    return root;
  };

  for (let a = 0; a < lines.length; a += 1) {
    for (let b = a + 1; b < lines.length; b += 1) {
      const first = lines[a];
      const second = lines[b];
      const shared = overlaps(first.x0, first.x1, second.x0, second.x1);
      const narrower = Math.min(first.x1 - first.x0, second.x1 - second.x0);
      const spacing = Math.max(first.y1 - first.y0, second.y1 - second.y0);
      if (
        shared > narrower * 0.3 &&
        Math.abs(first.y0 - second.y0) <= spacing * 1.9
      ) {
        parent[find(a)] = find(b);
      }
    }
  }

  const blocks = new Map<number, Line[]>();
  lines.forEach((line, index) => {
    const root = find(index);
    const block = blocks.get(root);
    if (block) {
      block.push(line);
    } else {
      blocks.set(root, [line]);
    }
  });

  return [...blocks.values()];
}

function buildCells(
  regions: Region[],
  lines: Line[],
  glyphShapes: Shape[],
): Cell[] {
  const parent = regions.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    return root;
  };

  const blocks = buildBlocks(lines);

  for (let a = 0; a < regions.length; a += 1) {
    for (let b = a + 1; b < regions.length; b += 1) {
      const first = regions[a];
      const second = regions[b];
      const sameWidth =
        Math.abs(first.x0 - second.x0) < 2 &&
        Math.abs(first.x1 - second.x1) < 2;
      if (!sameWidth) {
        continue;
      }

      const touchesAt =
        Math.abs(first.y0 - second.y1) < 2
          ? first.y0
          : Math.abs(first.y1 - second.y0) < 2
            ? first.y1
            : null;
      if (touchesAt === null) {
        continue;
      }

      const withinWidth = (x0: number, x1: number): boolean => {
        const centerX = (x0 + x1) / 2;
        return centerX >= first.x0 - 1 && centerX <= first.x1 + 1;
      };

      const courseIn = (region: Region): string =>
        parseCellText(
          lines
            .filter((line) =>
              contains(
                region,
                (line.x0 + line.x1) / 2,
                (line.y0 + line.y1) / 2,
              ),
            )
            .sort((a, b) => b.y0 - a.y0)
            .map((line) => line.text),
        ).course;

      const courseAbove = courseIn(first.y0 > second.y0 ? first : second);
      const courseBelow = courseIn(first.y0 > second.y0 ? second : first);
      if (courseAbove && courseAbove === courseBelow) {
        continue;
      }

      const blockCrosses = blocks.some((block) => {
        const centers = block
          .filter((line) => withinWidth(line.x0, line.x1))
          .map((line) => (line.y0 + line.y1) / 2);
        return (
          centers.some((center) => center > touchesAt) &&
          centers.some((center) => center < touchesAt)
        );
      });

      const glyphCrosses = glyphShapes.some(
        (shape) =>
          shape.y0 < touchesAt - 0.2 &&
          shape.y1 > touchesAt + 0.2 &&
          withinWidth(shape.x0, shape.x1),
      );

      if (blockCrosses || glyphCrosses) {
        parent[find(a)] = find(b);
      }
    }
  }

  const cells = new Map<number, Cell>();
  regions.forEach((region, index) => {
    const root = find(index);
    const cell = cells.get(root) ?? { regions: [], lines: [] };
    cell.regions.push(region);
    cells.set(root, cell);
  });

  for (const line of lines) {
    const centerX = (line.x0 + line.x1) / 2;
    const centerY = (line.y0 + line.y1) / 2;
    let index = regionAt(regions, centerX, centerY);
    if (index === -1) {
      let bestOverlap = 0;
      regions.forEach((region, candidate) => {
        if (centerX < region.x0 - 1 || centerX > region.x1 + 1) {
          return;
        }
        const amount = overlaps(region.y0, region.y1, line.y0, line.y1);
        if (amount > bestOverlap) {
          bestOverlap = amount;
          index = candidate;
        }
      });
    }
    if (index !== -1) {
      cells.get(find(index))?.lines.push(line);
    }
  }

  for (const cell of cells.values()) {
    cell.lines.sort((a, b) => b.y0 - a.y0);
  }

  return [...cells.values()];
}

export type ExtractOptions = {
  grid: Grid;
  shapes: Shape[];
  textItems: TextItem[];
  legend: Legend;
  pageCanvas: Canvas;
  pageHeight: number;
  lexicon: Set<string>;
};

export type ExtractResult = {
  entries: ScheduleEntry[];
  ocrCells: number;
  lowConfidenceCells: number;
  unknownFills: string[];
};

export async function extractEntries(
  options: ExtractOptions,
): Promise<ExtractResult> {
  const { grid, shapes, textItems, legend, pageCanvas, pageHeight, lexicon } =
    options;

  const blackShapes = shapes.filter((shape) => shape.fill === "#000000");
  const glyphShapes = blackShapes.filter(
    (shape) =>
      shape.x1 - shape.x0 < GLYPH_MAX_SIZE &&
      shape.y1 - shape.y0 < GLYPH_MAX_SIZE &&
      shape.x1 - shape.x0 > GLYPH_MIN_SIZE &&
      shape.y1 - shape.y0 > GLYPH_MIN_SIZE,
  );

  type PendingCell = {
    column: DayColumn;
    rows: { row: TimeRow; region: Region }[];
    lines: string[];
    bounds: { x0: number; x1: number; y0: number; y1: number };
  };

  const pending: PendingCell[] = [];

  for (const column of grid.dayColumns) {
    const regions = findRegions(shapes, blackShapes, grid, column);
    const contentTop = grid.timeRows[0].y1;
    const columnText = textItems.filter((item) => {
      const centerX = (item.x0 + item.x1) / 2;
      return (
        centerX > column.x0 &&
        centerX < column.x1 &&
        item.y0 >= grid.table.y0 &&
        (item.y0 + item.y1) / 2 <= contentTop &&
        !isDayName(item.text)
      );
    });

    const lines = buildLines(columnText, regions);

    for (const cell of buildCells(regions, lines, glyphShapes)) {
      const rows = rowsForCell(cell.regions, grid.timeRows);
      if (rows.length === 0) {
        continue;
      }

      const bounds = {
        x0: Math.min(...cell.regions.map((region) => region.x0)),
        x1: Math.max(...cell.regions.map((region) => region.x1)),
        y0: Math.min(...cell.regions.map((region) => region.y0)),
        y1: Math.max(...cell.regions.map((region) => region.y1)),
      };
      const cellLines = cell.lines.map((line) => line.text).filter(Boolean);

      if (cellLines.length === 0) {
        const glyphCount = glyphShapes.filter(
          (shape) =>
            shape.x0 > bounds.x0 + 1 &&
            shape.x1 < bounds.x1 - 1 &&
            shape.y0 > bounds.y0 + 1 &&
            shape.y1 < bounds.y1 - 1,
        ).length;
        if (glyphCount < MIN_GLYPHS_FOR_TEXT) {
          continue;
        }
      } else {
        const course = parseCellText(cellLines).course;
        if ((course.match(/\p{L}/gu) ?? []).length >= 2) {
          lexicon.add(course);
        }
      }

      pending.push({ column, rows, lines: cellLines, bounds });
    }
  }

  const entries: ScheduleEntry[] = [];
  let ocrCells = 0;
  let lowConfidenceCells = 0;

  for (const cell of pending) {
    let lines = cell.lines;
    let fromOcr = false;
    let ocrConfidence: number | undefined;

    if (lines.length === 0) {
      const recognized = await recognizeRotatedRegion(
        pageCanvas,
        {
          x0: cell.bounds.x0,
          x1: cell.bounds.x1,
          y0: cell.bounds.y0 - OCR_PADDING,
          y1: cell.bounds.y1 + OCR_PADDING,
        },
        pageHeight,
        OCR_SCALE,
      );
      ocrCells += 1;
      if (recognized.confidence < LOW_CONFIDENCE) {
        lowConfidenceCells += 1;
      }
      lines = [recognized.text];
      fromOcr = true;
      ocrConfidence = recognized.confidence;
    }

    const rawText = normalize(lines.join(" "));
    const parsed = parseCellText(lines);
    if ((parsed.course.match(/\p{L}/gu) ?? []).length < 2) {
      continue;
    }

    const course = fromOcr
      ? snapToLexicon(parsed.course, lexicon).name
      : parsed.course;
    if (OTHER_LABELS.test(course)) {
      continue;
    }

    let index = 0;
    while (index < cell.rows.length) {
      const classType = classifyRegion(cell.rows[index].region, legend);
      let end = index;
      while (
        end + 1 < cell.rows.length &&
        classifyRegion(cell.rows[end + 1].region, legend) === classType
      ) {
        end += 1;
      }

      entries.push({
        day: cell.column.day,
        startsAt: cell.rows[index].row.fromTime,
        endsAt: cell.rows[end].row.toTime,
        classType,
        course,
        group: parsed.group,
        room: parsed.room,
        fromOcr,
        ...(ocrConfidence === undefined
          ? {}
          : { ocrConfidence: Math.round(ocrConfidence) }),
        rawText,
      });

      index = end + 1;
    }
  }

  unifyCourseNames(entries);

  const unknownFills = [
    ...new Set(
      pending
        .flatMap((cell) => cell.rows.map((row) => row.region))
        .filter(
          (region) =>
            region.fill !== legend.lectureFill &&
            !isBackgroundFill(region.fill) &&
            !(region.dashed && legend.hasLabEntry),
        )
        .map((region) => region.fill),
    ),
  ];

  const dayOrder = grid.dayColumns.map((column) => column.day);
  entries.sort(
    (a, b) =>
      dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day) ||
      a.startsAt.localeCompare(b.startsAt) ||
      a.course.localeCompare(b.course),
  );

  return { entries, ocrCells, lowConfidenceCells, unknownFills };
}
