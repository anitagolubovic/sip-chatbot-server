import { isNotDefined } from "../../helper";
import { Maybe } from "../../models/types";
import type { TextItem } from "./pdfPageLoader";
import type { TableBox } from "./scheduleGrid";
import { cleanText } from "./textNormalization";

export type PdfHeader = {
  academicYear: Maybe<string>;
  moduleLabel: Maybe<string>;
  semester: Maybe<number>;
  programLabel: Maybe<string>;
};

const ROMAN: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
};

export function parseHeader(textItems: TextItem[], table: TableBox): PdfHeader {
  const above = textItems.filter((item) => item.y0 > table.y1);
  const rows: TextItem[][] = [];

  for (const item of [...above].sort((a, b) => b.y0 - a.y0 || a.x0 - b.x0)) {
    const row = rows.find((candidate) =>
      candidate.some((member) => Math.abs(member.y0 - item.y0) < 4),
    );
    if (row) {
      row.push(item);
    } else {
      rows.push([item]);
    }
  }

  const lines = rows.map((row) =>
    cleanText(
      [...row]
        .sort((a, b) => a.x0 - b.x0)
        .map((item) => item.text)
        .join(" "),
    ),
  );

  let academicYear: Maybe<string> = null;
  let moduleLabel: Maybe<string> = null;
  let semester: Maybe<number> = null;

  for (const line of lines) {
    const year = /(\d{4}\s*\/\s*\d{4})/.exec(line);
    if (year && isNotDefined(academicYear)) {
      academicYear = year[1].replace(/\s+/g, "");
    }

    const moduleMatch = /Модул\s*:?\s*(.+)$/i.exec(line);
    if (moduleMatch && isNotDefined(moduleLabel)) {
      moduleLabel = cleanText(moduleMatch[1]);
    }

    const semesterMatch = /Семестар\s*:?\s*([IVX]+)\b/i.exec(line);
    if (semesterMatch && isNotDefined(semester)) {
      semester = ROMAN[semesterMatch[1].toUpperCase()] ?? null;
    }
  }

  const programLabel =
    lines.find(
      (line) =>
        line.length > 3 &&
        !/Универзитет|Електронски факултет|Школска година|Распоред часова|Семестар|Модул/i.test(
          line,
        ),
    ) ?? null;

  return {
    academicYear,
    moduleLabel: moduleLabel ?? programLabel,
    semester,
    programLabel,
  };
}

