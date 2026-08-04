import type { Shape, TextItem } from "./pdfPageLoader";

export type Day =
  | "ponedeljak"
  | "utorak"
  | "sreda"
  | "cetvrtak"
  | "petak"
  | "subota";

export type DayColumn = {
  day: Day;
  x0: number;
  x1: number;
};

export type TimeRow = {
  fromTime: string;
  toTime: string;
  y0: number;
  y1: number;
};

export type TableBox = {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
};

export type Grid = {
  table: TableBox;
  dayColumns: DayColumn[];
  timeRows: TimeRow[];

  timeColumnX1: number;
};

const DAY_HEADERS: { pattern: RegExp; day: Day }[] = [
  { pattern: /^понедељак$/i, day: "ponedeljak" },
  { pattern: /^уторак$/i, day: "utorak" },
  { pattern: /^среда$/i, day: "sreda" },
  { pattern: /^четвртак$/i, day: "cetvrtak" },
  { pattern: /^петак$/i, day: "petak" },
  { pattern: /^субота$/i, day: "subota" },
];

export function isDayName(text: string): boolean {
  const normalized = text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return DAY_HEADERS.some((candidate) => candidate.pattern.test(normalized));
}

function isVerticalLine(shape: Shape): boolean {
  return shape.x1 - shape.x0 < 4 && shape.y1 - shape.y0 > 10;
}

function isHorizontalLine(shape: Shape): boolean {
  return shape.y1 - shape.y0 < 4 && shape.x1 - shape.x0 > 10;
}

function clusterValues(values: number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];

  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last[last.length - 1] <= tolerance) {
      last.push(value);
    } else {
      clusters.push([value]);
    }
  }

  return clusters.map(
    (cluster) =>
      cluster.reduce((sum, value) => sum + value, 0) / cluster.length,
  );
}

function normalize(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

export function findTableBox(shapes: Shape[]): TableBox {
  const verticals = shapes.filter(isVerticalLine);
  const horizontals = shapes.filter(isHorizontalLine);
  if (verticals.length === 0 || horizontals.length === 0) {
    throw new Error("U PDF-u nisu pronadjene linije tabele.");
  }

  const maxWidth = Math.max(...horizontals.map((shape) => shape.x1 - shape.x0));
  const fullWidth = horizontals.filter(
    (shape) => shape.x1 - shape.x0 > maxWidth * 0.9,
  );

  const maxHeight = Math.max(...verticals.map((shape) => shape.y1 - shape.y0));
  const fullHeight = verticals.filter(
    (shape) => shape.y1 - shape.y0 > maxHeight * 0.9,
  );

  return {
    x0: Math.min(...fullWidth.map((shape) => shape.x0)),
    x1: Math.max(...fullWidth.map((shape) => shape.x1)),
    y0: Math.min(...fullHeight.map((shape) => shape.y0)),
    y1: Math.max(...fullHeight.map((shape) => shape.y1)),
  };
}

function buildDayColumns(
  shapes: Shape[],
  textItems: TextItem[],
  table: TableBox,
): DayColumn[] {
  const height = table.y1 - table.y0;

  const boundaries = clusterValues(
    shapes
      .filter(
        (shape) => isVerticalLine(shape) && shape.y1 - shape.y0 > height * 0.8,
      )
      .map((shape) => (shape.x0 + shape.x1) / 2),
    3,
  );

  if (boundaries.length < 3) {
    throw new Error(
      `Prepoznato je samo ${boundaries.length} vertikalnih granica kolona.`,
    );
  }

  const headers = textItems
    .map((item) => {
      const text = normalize(item.text);
      const match = DAY_HEADERS.find((candidate) =>
        candidate.pattern.test(text),
      );
      return match ? { day: match.day, center: (item.x0 + item.x1) / 2 } : null;
    })
    .filter((value): value is { day: Day; center: number } => value !== null);

  if (headers.length === 0) {
    throw new Error("U zaglavlju tabele nije prepoznat nijedan dan u nedelji.");
  }

  const candidates = new Map<Day, number[]>();
  for (const header of headers) {
    let columnIndex = -1;
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
      if (
        header.center >= boundaries[index] &&
        header.center <= boundaries[index + 1]
      ) {
        columnIndex = index;
        break;
      }
    }
    if (columnIndex === -1) {
      continue;
    }
    const list = candidates.get(header.day) ?? [];
    if (!list.includes(columnIndex)) {
      list.push(columnIndex);
    }
    candidates.set(header.day, list);
  }

  const columns: DayColumn[] = [];
  let previousIndex = -1;
  for (const { day } of DAY_HEADERS) {
    const list = candidates.get(day);
    if (!list) {
      continue;
    }
    const chosen = [...list]
      .sort((a, b) => a - b)
      .find((index) => index > previousIndex);
    if (chosen === undefined) {
      continue;
    }
    previousIndex = chosen;
    columns.push({
      day,
      x0: boundaries[chosen],
      x1: boundaries[chosen + 1],
    });
  }

  if (columns.length === 0) {
    throw new Error(
      "Nijedan dan u nedelji nije mogao da se veze za kolonu tabele.",
    );
  }

  return columns;
}

function buildTimeRows(
  shapes: Shape[],
  textItems: TextItem[],
  table: TableBox,
  timeColumnX1: number,
): TimeRow[] {
  const width = timeColumnX1 - table.x0;

  const boundaries = clusterValues(
    [
      ...shapes
        .filter(
          (shape) =>
            isHorizontalLine(shape) &&
            shape.x0 <= table.x0 + width * 0.5 &&
            shape.x1 >= table.x0 + width * 0.5,
        )
        .map((shape) => (shape.y0 + shape.y1) / 2),
      table.y0,
      table.y1,
    ],
    3,
  );

  if (boundaries.length < 5) {
    throw new Error(
      `Prepoznato je samo ${boundaries.length} horizontalnih granica redova.`,
    );
  }

  const timeTexts = textItems.filter(
    (item) =>
      item.x0 >= table.x0 - 2 &&
      item.x1 <= timeColumnX1 + 2 &&
      /^\d{1,2}$/.test(normalize(item.text)),
  );

  const rows: TimeRow[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const y0 = boundaries[index];
    const y1 = boundaries[index + 1];
    const parts = timeTexts
      .filter((item) => {
        const center = (item.y0 + item.y1) / 2;
        return center > y0 && center < y1;
      })
      .sort((a, b) => a.x0 - b.x0)
      .map((item) => normalize(item.text));

    if (parts.length !== 4) {
      continue;
    }

    const [fromHour, fromMinute, toHour, toMinute] = parts;
    rows.push({
      fromTime: `${fromHour.padStart(2, "0")}:${fromMinute.padStart(2, "0")}`,
      toTime: `${toHour.padStart(2, "0")}:${toMinute.padStart(2, "0")}`,
      y0,
      y1,
    });
  }

  if (rows.length < 4) {
    throw new Error(
      `Iz vremenske kolone je procitano samo ${rows.length} redova.`,
    );
  }

  rows.sort((a, b) => b.y0 - a.y0);
  return rows;
}

export function buildGrid(shapes: Shape[], textItems: TextItem[]): Grid {
  const table = findTableBox(shapes);
  const dayColumns = buildDayColumns(shapes, textItems, table);
  const timeColumnX1 = dayColumns[0].x0;
  const timeRows = buildTimeRows(shapes, textItems, table, timeColumnX1);

  return { table, dayColumns, timeRows, timeColumnX1 };
}

export function assertGeometryIsConsistent(
  grid: Grid,
  textItems: TextItem[],
): void {
  for (const column of grid.dayColumns) {
    const headers = textItems.filter((item) => {
      const text = normalize(item.text);
      const match = DAY_HEADERS.find((candidate) =>
        candidate.pattern.test(text),
      );
      return match?.day === column.day;
    });
    if (headers.length === 0) {
      continue;
    }

    const matching = headers.filter((header) => {
      const center = (header.x0 + header.x1) / 2;
      return center >= column.x0 && center <= column.x1;
    });
    if (matching.length === 0) {
      throw new Error(
        `Geometrija teksta i linija se ne poklapa za kolonu "${column.day}".`,
      );
    }
    if (
      matching.every(
        (header) => header.y0 < grid.table.y0 || header.y0 > grid.table.y1,
      )
    ) {
      throw new Error(
        `Zaglavlje "${column.day}" je izvan okvira tabele - koordinatni sistemi se razlikuju.`,
      );
    }
  }
}
