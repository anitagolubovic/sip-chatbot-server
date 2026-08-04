import { latinSearchText } from "./textNormalization";

const MONTH_BY_PREFIX: { [prefix: string]: number } = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  maj: 5,
  jun: 6,
  jul: 7,
  avg: 8,
  sep: 9,
  okt: 10,
  nov: 11,
  dec: 12,
};

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function monthNumber(name: string): number | null {
  return MONTH_BY_PREFIX[latinSearchText(name).slice(0, 3)] ?? null;
}

const TEXTUAL_DATE = /(\d{1,2})\.\s*(\p{L}+)[,.]?\s*(20\d{2})/u;
const NUMERIC_DATE = /(\d{1,2})\.(\d{1,2})\.(\d{4})\./g;

export function parseTextualDate(text: string): string | null {
  const match = TEXTUAL_DATE.exec(text);
  if (!match) {
    return null;
  }
  const month = monthNumber(match[2]);
  return month ? isoDate(Number(match[3]), month, Number(match[1])) : null;
}

export function numericDatesIn(text: string): string[] {
  return [...text.matchAll(NUMERIC_DATE)].map(([, day, month, year]) =>
    isoDate(Number(year), Number(month), Number(day)),
  );
}
