import { query } from "../db/pool";
import { toSearchForm } from "../preprocessing";
import { currentAcademicYear } from "../scraper/lib/scraperRuntime";
import { Maybe } from "../models/types";
import {
  detectClassTypes,
  detectStudyLevel,
  STUDY_LEVEL_LABELS,
  type StudyLevelFilter,
} from "./questionParsing";

const COURSE_MATCH_THRESHOLD = 0.45;
const AMBIGUITY_MARGIN = 0.15;
const STRONG_MATCH_SCORE = 0.6;
const STRONG_MATCH_RATIO = 1.2;
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
  roomsByGroup: Record<string, string>;
  studyLevel: string;
  semester: Maybe<number>;
  semesterType: Maybe<string>;
  moduleLabel: Maybe<string>;
  fromOcr: boolean;
};

export function detectDay(normalizedQuestion: string): Maybe<string> {
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
  if (!next || best.score - next.score >= AMBIGUITY_MARGIN) {
    return best.course;
  }
  // Duze pitanje ("... na osnovnim studijama na UPS modulu") podize slicnost
  // nevezanim predmetima koji dele pokoju rec, pa apsolutna razlika padne
  // ispod margine i pored toga sto je prvi kandidat ubedljivo najbolji.
  // Tada odlucuje odnos rezultata, ali samo za dovoljno jako poklapanje.
  return best.score >= STRONG_MATCH_SCORE &&
    best.score >= next.score * STRONG_MATCH_RATIO
    ? best.course
    : null;
}

export async function findScheduleSlots(filters: {
  academicYear: string;
  course: string;
  day?: Maybe<string>;
  studyLevel?: Maybe<StudyLevelFilter>;
  classTypes?: Maybe<string[]>;
  limit?: number;
}): Promise<ScheduleSlot[]> {
  // DISTINCT: isti termin se ponavlja kada dva modula dele oznaku (npr. ELK
  // pokriva i EKES i EMT), pa bi bez toga svaki red bio prikazan dvaput.
  return query<ScheduleSlot>(
    `SELECT DISTINCT
            e.course, e.day, e.starts_at AS "startsAt", e.ends_at AS "endsAt",
            e.class_type AS "classType", e.room, e.groups,
            e.rooms_by_group AS "roomsByGroup", e.from_ocr AS "fromOcr",
            s.study_level AS "studyLevel", s.semester,
            s.semester_type AS "semesterType", s.module_label AS "moduleLabel"
     FROM schedule_entries e
     JOIN schedules s ON s.id = e.schedule_id
     WHERE s.academic_year = $1
       AND e.course = $2
       AND ($3::text IS NULL OR e.day = $3)
       AND ($4::text IS NULL OR s.study_level = $4)
       AND ($5::text[] IS NULL OR e.class_type = ANY($5))
     ORDER BY s.semester, s.module_label, e.day, e.starts_at
     LIMIT $6`,
    [
      filters.academicYear,
      filters.course,
      filters.day ?? null,
      filters.studyLevel ?? null,
      filters.classTypes ?? null,
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

// Prva godina OAS deli vezbe na grupe koje sede u razlicitim salama, pa se
// sala navodi uz svaku grupu. Kada je sala ista kao sala celog termina (sto
// je slucaj na predavanjima) ne ponavlja se, da kontekst ostane kratak.
function formatGroups(slot: ScheduleSlot): Maybe<string> {
  if (slot.groups.length === 0) {
    return null;
  }

  const labelled = slot.groups.map((group) => {
    const room = slot.roomsByGroup?.[group];
    return room && room !== slot.room ? `${group} (сала ${room})` : group;
  });

  return `групе ${labelled.join(", ")}`;
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
      formatGroups(slot),
    ].filter(Boolean);

    lines.push(
      `- ${DAY_LABELS[slot.day] ?? slot.day} ${time}, ${details.join(", ")}`,
    );
  }

  return lines.join("\n");
}

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
  const classTypes = detectClassTypes(normalizedQuestion);

  let slots = await findScheduleSlots({
    academicYear,
    course,
    day,
    studyLevel,
    classTypes,
  });

  // Predmet postoji, ali ne u tom danu, nivou ili vrsti nastave: bolje
  // pokazati ceo raspored predmeta nego odgovoriti da ga nema.
  if (slots.length === 0 && (day || studyLevel || classTypes)) {
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
