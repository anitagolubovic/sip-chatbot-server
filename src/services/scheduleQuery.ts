import { query } from "../db/pool";
import { toSearchForm } from "../preprocessing";
import { currentAcademicYear } from "../scraper/lib/scraperRuntime";
import { Maybe } from "../models/types";
import {
  detectStudyLevel,
  STUDY_LEVEL_LABELS,
  type StudyLevelFilter,
} from "./questionParsing";

const COURSE_MATCH_THRESHOLD = 0.45;
const AMBIGUITY_MARGIN = 0.15;
const MAX_CANDIDATES = 4;

const DAY_LABELS: { [day: string]: string } = {
  ponedeljak: "понедељак",
  utorak: "уторак",
  sreda: "среда",
  cetvrtak: "четвртак",
  petak: "петак",
  subota: "субота",
};

const SEMESTER_TYPE_LABELS: { [semesterType: string]: string } = {
  zimski: "зимски",
  letnji: "летњи",
};

const CLASS_TYPE_LABELS: { [classType: string]: string } = {
  predavanje: "предавања",
  racunske_vezbe: "рачунске вежбе",
  laboratorijske_vezbe: "лабораторијске вежбе",
  ostali_casovi: "остали часови",
};

export type ScheduleCourseCandidate = { course: string; score: number };

export type ScheduleSlot = {
  course: string;
  day: string;
  startsAt: Maybe<string>;
  endsAt: Maybe<string>;
  classType: Maybe<string>;
  room: Maybe<string>;
  groups: string[];
  studyLevel: string;
  semester: Maybe<number>;
  semesterType: Maybe<string>;
  moduleLabel: Maybe<string>;
  fromOcr: boolean;
};

export function detectDay(normalizedQuestion: string): Maybe<string> {
  // Upitni oblici ("u ponedeljak", "petkom") dele koren sa nazivom dana.
  const stems: ReadonlyArray<[string, RegExp]> = [
    ["ponedeljak", /ponedelj/],
    ["utorak", /utor/],
    ["sreda", /sred/],
    ["cetvrtak", /cetvrt/],
    ["petak", /pet(ak|kom|ka)/],
    ["subota", /subot/],
  ];
  return (
    stems.find(([, pattern]) => pattern.test(normalizedQuestion))?.[0] ?? null
  );
}

export async function findScheduleCourses(
  normalizedQuestion: string,
  academicYear: string,
): Promise<ScheduleCourseCandidate[]> {
  const rows = await query<{ course: string; score: number }>(
    `SELECT e.course, word_similarity(e.course_norm, $1) AS score
     FROM schedule_entries e
     JOIN schedules s ON s.id = e.schedule_id
     WHERE s.academic_year = $2
     GROUP BY e.course, e.course_norm
     HAVING word_similarity(e.course_norm, $1) >= $3
     ORDER BY score DESC, e.course
     LIMIT $4`,
    [normalizedQuestion, academicYear, COURSE_MATCH_THRESHOLD, MAX_CANDIDATES],
  );

  return rows.map((row) => ({
    course: row.course,
    score: Number(row.score),
  }));
}

export function resolveScheduleCourse(
  candidates: ScheduleCourseCandidate[],
): Maybe<string> {
  const [best, next] = candidates;
  if (!best) return null;
  return !next || best.score - next.score >= AMBIGUITY_MARGIN
    ? best.course
    : null;
}

export async function findScheduleSlots(filters: {
  academicYear: string;
  course: string;
  day?: Maybe<string>;
  studyLevel?: Maybe<StudyLevelFilter>;
  limit?: number;
}): Promise<ScheduleSlot[]> {
  return query<ScheduleSlot>(
    `SELECT e.course, e.day, e.starts_at AS "startsAt", e.ends_at AS "endsAt",
            e.class_type AS "classType", e.room, e.groups, e.from_ocr AS "fromOcr",
            s.study_level AS "studyLevel", s.semester,
            s.semester_type AS "semesterType", s.module_label AS "moduleLabel"
     FROM schedule_entries e
     JOIN schedules s ON s.id = e.schedule_id
     WHERE s.academic_year = $1
       AND e.course = $2
       AND ($3::text IS NULL OR e.day = $3)
       AND ($4::text IS NULL OR s.study_level = $4)
     ORDER BY s.semester, e.day, e.starts_at
     LIMIT $5`,
    [
      filters.academicYear,
      filters.course,
      filters.day ?? null,
      filters.studyLevel ?? null,
      filters.limit ?? 40,
    ],
  );
}

export type ScheduleLookup = {
  status: "ok" | "ambiguous" | "not_found" | "no_match";
  candidates: ScheduleCourseCandidate[];
  slots: ScheduleSlot[];
  context: string;
};

function slotGroupHeading(slot: ScheduleSlot): string {
  const parts = [
    STUDY_LEVEL_LABELS[slot.studyLevel] ?? slot.studyLevel,
    slot.semester ? `${slot.semester}. семестар` : null,
    slot.moduleLabel,
  ].filter(Boolean);
  return `${slot.course} (${parts.join(", ")}):`;
}

export function formatScheduleContext(slots: ScheduleSlot[]): string {
  const lines: string[] = [];
  let currentHeading = "";

  for (const slot of slots) {
    const heading = slotGroupHeading(slot);
    if (heading !== currentHeading) {
      currentHeading = heading;
      lines.push(heading);
    }

    const time =
      slot.startsAt && slot.endsAt ? `${slot.startsAt}–${slot.endsAt}` : "";
    const details = [
      CLASS_TYPE_LABELS[slot.classType ?? ""] ?? slot.classType,
      slot.room ? `сала ${slot.room}` : null,
      slot.groups.length > 0 ? `групе ${slot.groups.join(", ")}` : null,
    ].filter(Boolean);

    lines.push(
      `- ${DAY_LABELS[slot.day] ?? slot.day} ${time}, ${details.join(", ")}`,
    );
  }

  return lines.join("\n");
}

/**
 * Ceo put od pitanja do konteksta za raspored casova. Trazi se predmet, jer
 * pitanja bez predmeta ("koji su casovi u ponedeljak") pogadjaju ceo fakultet.
 */
export async function lookupSchedule(
  question: string,
  academicYear = currentAcademicYear(),
): Promise<ScheduleLookup> {
  const normalizedQuestion = toSearchForm(question);
  const candidates = await findScheduleCourses(
    normalizedQuestion,
    academicYear,
  );
  const empty = { candidates, slots: [], context: "" };

  if (candidates.length === 0) {
    return { ...empty, status: "no_match" };
  }

  const course = resolveScheduleCourse(candidates);
  if (!course) {
    return { ...empty, status: "ambiguous" };
  }

  const day = detectDay(normalizedQuestion);
  const studyLevel = detectStudyLevel(normalizedQuestion);

  let slots = await findScheduleSlots({
    academicYear,
    course,
    day,
    studyLevel,
  });

  // Predmet postoji, ali ne u tom danu ili na tom nivou: bolje pokazati ceo
  // raspored predmeta nego odgovoriti da ga nema.
  if (slots.length === 0 && (day || studyLevel)) {
    slots = await findScheduleSlots({ academicYear, course });
  }

  if (slots.length === 0) {
    return { ...empty, status: "not_found" };
  }

  const semesterTypes = [...new Set(slots.map((slot) => slot.semesterType))];
  const heading =
    `РАСПОРЕД ЧАСОВА (школска ${academicYear}` +
    (semesterTypes.length === 1 && semesterTypes[0]
      ? `, ${SEMESTER_TYPE_LABELS[semesterTypes[0]] ?? semesterTypes[0]} семестар`
      : "") +
    ")";

  return {
    status: "ok",
    candidates,
    slots,
    context: `${heading}:\n${formatScheduleContext(slots)}`,
  };
}
