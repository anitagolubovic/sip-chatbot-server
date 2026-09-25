import * as cheerio from "cheerio";
import { parseTextualDate } from "./serbianDates";
import { cleanText, latinSearchText } from "./textNormalization";
import type { ExamSlot } from "../../models/examSchedule";
import { Maybe } from "../../models/types";

const STUDY_LEVEL_BY_LABEL: { [label: string]: string } = {
  oas: "osnovne_akademske",
  mas: "master_akademske",
};

// Satnice razlicitih rokova nemaju iste kolone (nivo i trajanje se nekad
// izostavljaju), pa se kolona prepoznaje po pocetku naslova u zaglavlju.
const FIELD_BY_HEADER: ReadonlyArray<[string, keyof ExamSlot]> = [
  ["dat", "date"],
  ["niv", "studyLevel"],
  ["vrem", "time"],
  ["traj", "durationMinutes"],
  ["sif", "courseCode"],
  ["naziv", "courseName"],
  ["sal", "rooms"],
];

const PERIOD_BY_STEM: ReadonlyArray<[string, string]> = [
  ["decemb", "decembarski"],
  ["januar", "januarski"],
  ["februar", "februarski"],
  ["april", "aprilski"],
  ["jun", "junski"],
  ["septemb", "septembarski"],
  ["oktob", "oktobarski"],
];

// "satnica-jun-dva-2026" i "u dodatnom junskom roku" su dodatni rok, koji u
// rasporedu ispita ima svoj naziv ("dodatni-junski").
const ADDITIONAL_PERIOD = /dodat|drug|trec|-dva-|-tri-|-[23]-/;

type Field = keyof ExamSlot;

export function examPeriodOfTitle(title: string, url: string): Maybe<string> {
  const text = `${latinSearchText(title)} ${url.toLowerCase()}`;
  const period = PERIOD_BY_STEM.find(([stem]) => text.includes(stem))?.[1];
  if (!period) return null;
  return ADDITIONAL_PERIOD.test(text) ? `dodatni-${period}` : period;
}

/** "... у јануарском испитном року на МАС" nema kolonu nivoa, nivo je u naslovu. */
export function studyLevelOfTitle(title: string): Maybe<string> {
  const match = /\bna (oas|mas)\b/.exec(latinSearchText(title));
  return match ? STUDY_LEVEL_BY_LABEL[match[1]] : null;
}

export function parseExamSlotTable(
  html: string,
  defaultStudyLevel: Maybe<string>,
): ExamSlot[] {
  const $ = cheerio.load(html);
  const slots: ExamSlot[] = [];

  for (const table of $("table").toArray()) {
    let fields: Maybe<Array<Maybe<Field>>> = null;

    for (const row of $(table).find("tr").toArray()) {
      const cells = $(row)
        .find("td, th")
        .toArray()
        .map((cell) => cleanText($(cell).text()));

      if (!fields) {
        fields = headerFields(cells);
        continue;
      }
      const slot = toSlot(fields, cells, defaultStudyLevel);
      if (slot) slots.push(slot);
    }
  }

  return slots;
}

function headerFields(cells: string[]): Maybe<Array<Maybe<Field>>> {
  const fields = cells.map((cell) => {
    const header = latinSearchText(cell);
    return (
      FIELD_BY_HEADER.find(([prefix]) => header.startsWith(prefix))?.[1] ??
      null
    );
  });
  return fields.includes("courseCode") && fields.includes("date")
    ? fields
    : null;
}

function toSlot(
  fields: Array<Maybe<Field>>,
  cells: string[],
  defaultStudyLevel: Maybe<string>,
): Maybe<ExamSlot> {
  const value = (field: Field) => cells[fields.indexOf(field)] ?? "";

  const courseCode = value("courseCode").replace(/\s+/g, "");
  const date = parseTextualDate(value("date"));
  if (!courseCode || !date) return null;

  return {
    studyLevel:
      STUDY_LEVEL_BY_LABEL[latinSearchText(value("studyLevel"))] ??
      defaultStudyLevel,
    courseCode,
    courseName: value("courseName"),
    date,
    time: parseTime(value("time")),
    durationMinutes: parseDuration(value("durationMinutes")),
    rooms: parseRooms(value("rooms")),
  };
}

/** "09:00", "14 ч." ili "9 ч." */
function parseTime(text: string): Maybe<string> {
  const match = /(\d{1,2})(?:[:.](\d{2}))?\s*(?:ч|h|$)/.exec(text.trim());
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2] ?? "00"}`;
}

/** "04:00:00" ili "00:45:00"; "предавач" znaci da trajanje odredjuje predavac. */
function parseDuration(text: string): Maybe<number> {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes > 0 ? minutes : null;
}

/** "A4, 75 (К1), " -> "A4, 75 (К1)" */
function parseRooms(text: string): Maybe<string> {
  const rooms = text
    .split(",")
    .map((room) => room.trim())
    .filter((room) => room.length > 0)
    .join(", ");
  return rooms || null;
}
