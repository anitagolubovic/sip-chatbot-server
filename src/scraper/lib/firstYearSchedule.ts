//iz indeksa se cita grupa i sala

import * as cheerio from "cheerio";
import { composeTextLines } from "./scheduleEntryExtractor";
import type { ScheduleEntry } from "./scheduleEntryExtractor";
import type { Grid } from "./scheduleGrid";
import type { TextItem } from "./pdfPageLoader";
import { fetchHtml } from "./httpClient";

export const GROUPS_PAGE_URL =
  "https://sip.elfak.ni.ac.rs/article/nastava/oas-grupe-2025";

export type GroupRooms = {
  lectures: Record<string, string>;
  exercises: Record<string, string>;
};

export type IndexGroupRange = {
  indexFrom: number;
  indexTo: number;
  lectureGroup: string;
  exerciseGroup: string;
};

function normalize(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

export function isFirstYearOas(studyLevel: string, semester: number): boolean {
  return (
    studyLevel === "osnovne_akademske" && (semester === 1 || semester === 2)
  );
}

export function parseGroupRooms(textItems: TextItem[], grid: Grid): GroupRooms {
  const lastDay = grid.dayColumns[grid.dayColumns.length - 1];
  const noteItems = textItems.filter((item) => {
    const centerX = (item.x0 + item.x1) / 2;
    return (
      centerX > lastDay.x1 &&
      item.y0 >= grid.table.y0 &&
      item.y1 <= grid.table.y1
    );
  });

  const lectures: Record<string, string> = {};
  const exercises: Record<string, string> = {};
  let section: "lectures" | "exercises" | null = null;

  for (const line of composeTextLines(noteItems)) {
    const text = normalize(line);

    if (/сале\s+за\s+предавања/i.test(text)) {
      section = "lectures";
      continue;
    }
    if (/сале\s+за\s+рачунске/i.test(text)) {
      section = "exercises";
      continue;
    }

    const match = /група\s+([^\s-]{1,3})\s*[-–—]\s*(\S{1,10})\s*$/i.exec(text);
    if (!match || section === null) {
      continue;
    }

    const group = normalize(match[1]);
    const room = normalize(match[2]);
    if (section === "lectures") {
      lectures[group] = room;
    } else {
      exercises[group] = room;
    }
  }

  return { lectures, exercises };
}

export function parseIndexGroups(html: string): IndexGroupRange[] {
  const $ = cheerio.load(html);
  const table = $("table")
    .filter((_, element) =>
      normalize($(element).text()).includes("Од броја индекса"),
    )
    .first();

  if (table.length === 0) {
    throw new Error(
      "Na stranici sa grupama nije pronadjena tabela sa indeksima.",
    );
  }

  const ranges: IndexGroupRange[] = [];
  let lectureGroup = "";

  table.find("tr").each((_, row) => {
    const cells = $(row)
      .find("td")
      .map((__, cell) => normalize($(cell).text()))
      .get();

    const indexFrom = Number.parseInt(cells[0] ?? "", 10);
    const indexTo = Number.parseInt(cells[1] ?? "", 10);
    if (!Number.isInteger(indexFrom) || !Number.isInteger(indexTo)) {
      return;
    }

    let exerciseGroup: string;
    if (cells.length >= 4) {
      lectureGroup = cells[2];
      exerciseGroup = cells[3];
    } else {
      exerciseGroup = cells[2];
    }

    if (lectureGroup && exerciseGroup) {
      ranges.push({ indexFrom, indexTo, lectureGroup, exerciseGroup });
    }
  });

  if (ranges.length === 0) {
    throw new Error(
      "Iz tabele sa grupama nije procitan nijedan raspon indeksa.",
    );
  }
  return ranges;
}

export async function fetchIndexGroups(
  url: string = GROUPS_PAGE_URL,
): Promise<IndexGroupRange[]> {
  return parseIndexGroups(await fetchHtml(url));
}

const LOOKALIKE: Record<string, string> = {
  Т: "1",
  Г: "1",
  І: "1",
  I: "1",
  L: "1",
  З: "3",
  "5": "Б",
  "6": "Б",
  A: "А",
  B: "Б",
  C: "Ц",
  O: "0",
};

function canonicalGroup(token: string): string {
  return [...token.toUpperCase()]
    .map((character) => LOOKALIKE[character] ?? character)
    .join("");
}

const EXPLICIT_ROOM =
  /(амфитеатар|сала|учионица|лаб(?:ораторија)?)\s*[.:]?\s*([\p{L}0-9]{1,6})/iu;

export function findExplicitRoom(rawText: string): string | null {
  const match = EXPLICIT_ROOM.exec(rawText);
  return match ? normalize(`${match[1]} ${match[2]}`) : null;
}

export function resolveGroups(
  rawText: string,
  classType: ScheduleEntry["classType"],
  rooms: GroupRooms,
): string[] {
  rawText = rawText.replace(EXPLICIT_ROOM, " ");
  const vocabulary = Object.keys(
    classType === "predavanje" ? rooms.lectures : rooms.exercises,
  );
  if (vocabulary.length === 0) {
    return [];
  }

  const canonicalVocabulary = new Map<string, string>();
  for (const group of vocabulary) {
    canonicalVocabulary.set(canonicalGroup(group), group);
  }

  const found: string[] = [];
  for (const token of rawText.split(/[\s,;.()\-–—]+/)) {
    if (!token || token.length > 3) {
      continue;
    }
    const resolved = canonicalVocabulary.get(canonicalGroup(token));
    if (resolved && !found.includes(resolved)) {
      found.push(resolved);
    }
  }

  if (found.length === 0 && classType !== "predavanje") {
    for (const token of rawText.split(/[\s,;.()\-–—]+/)) {
      if (
        !token ||
        token.length !== 1 ||
        !rooms.lectures[canonicalGroup(token)]
      ) {
        continue;
      }
      const lectureGroup = canonicalGroup(token);
      for (const group of vocabulary) {
        if (group.startsWith(lectureGroup) && !found.includes(group)) {
          found.push(group);
        }
      }
    }
  }

  return found.sort();
}

function stripGroups(course: string, groups: string[]): string {
  if (groups.length === 0) {
    return normalize(course.replace(/[\s]*[-–—]+[\s]*$/, ""));
  }

  const canonical = new Set(groups.map(canonicalGroup));
  const kept = course
    .split(/\s+/)
    .filter((word) => {
      const bare = word.replace(/[,;.()\-–—]/g, "");
      return bare.length > 3 || !canonical.has(canonicalGroup(bare));
    })
    .join(" ");

  return normalize(kept.replace(/[\s]*[-–—]+[\s]*$/, "").replace(/,\s*$/, ""));
}

export type FirstYearEntry = ScheduleEntry & {
  groups: string[];
  roomsByGroup: Record<string, string>;
};

export function enrichFirstYearEntries(
  entries: ScheduleEntry[],
  rooms: GroupRooms,
): { entries: FirstYearEntry[]; withoutGroup: number } {
  let withoutGroup = 0;

  const enriched = entries.map((entry) => {
    const explicitRoom = findExplicitRoom(entry.rawText);
    const groups = resolveGroups(entry.rawText, entry.classType, rooms);
    const table =
      entry.classType === "predavanje" ? rooms.lectures : rooms.exercises;

    const roomsByGroup: Record<string, string> = {};
    for (const group of groups) {
      if (table[group]) {
        roomsByGroup[group] = table[group];
      }
    }

    const distinct = [...new Set(Object.values(roomsByGroup))];
    if (groups.length === 0 && !explicitRoom) {
      withoutGroup += 1;
    }

    return {
      ...entry,
      course: stripGroups(entry.course, groups),
      groups,
      roomsByGroup,
      room:
        explicitRoom ??
        entry.room ??
        (distinct.length === 1 ? distinct[0] : null),
    };
  });

  return { entries: enriched, withoutGroup };
}
