import { query } from "../db/pool";
import { toSearchForm } from "../preprocessing";
import { currentAcademicYear } from "../scraper/lib/scraperRuntime";
import { Maybe } from "../models/types";
import {
  detectStudyLevel,
  formatDate,
  formatRange,
  STUDY_LEVEL_LABELS,
  type StudyLevelFilter,
} from "./questionParsing";

export enum CalendarTopic {
  Semester = "semestar",
  Vacation = "raspust",
  SemesterValidation = "overa",
  ExamPeriod = "ispitni_rok",
  ExamRegistration = "prijava_ispita",
  Days = "radni_neradni_dani",
}

const TOPIC_PATTERNS: ReadonlyArray<[CalendarTopic, RegExp]> = [
  [CalendarTopic.ExamRegistration, /prijav/],
  [CalendarTopic.SemesterValidation, /overa|overi|upis semestra/],
  [CalendarTopic.Vacation, /raspust|pauz|odmor|ferije/],
  [CalendarTopic.ExamPeriod, /ispitni rok|rokov|ispitn/],
  [CalendarTopic.Semester, /semestar|semestr|nastava pocinje|pocetak nastave/],
  [CalendarTopic.Days, /praznik|neradn|radna subota|radni dan|slobodan dan/],
];

export type CalendarLevel = {
  studyLevel: string;
  label: Maybe<string>;
  autumnFrom: Maybe<string>;
  autumnTo: Maybe<string>;
  springFrom: Maybe<string>;
  springTo: Maybe<string>;
  vacationFrom: Maybe<string>;
  vacationTo: Maybe<string>;
  semesterValidation: Maybe<string>;
};

export type CalendarExamPeriod = {
  studyLevel: string;
  name: string;
  label: Maybe<string>;
  heldFrom: Maybe<string>;
  heldTo: Maybe<string>;
  applyFrom: Maybe<string>;
  applyTo: Maybe<string>;
};

export type CalendarDay = {
  kind: string;
  firstDay: string;
  days: number;
  note: Maybe<string>;
};

const SEMESTER_DURATION = /pocin|pocet|zavrs|traj|kada je nastava/;

export function detectCalendarTopics(
  normalizedQuestion: string,
): CalendarTopic[] {
  const topics = TOPIC_PATTERNS.filter(([, pattern]) =>
    pattern.test(normalizedQuestion),
  ).map(([topic]) => topic);

  const overlapsValidation =
    topics.includes(CalendarTopic.SemesterValidation) &&
    !SEMESTER_DURATION.test(normalizedQuestion);

  return overlapsValidation
    ? topics.filter((topic) => topic !== CalendarTopic.Semester)
    : topics;
}

export async function findCalendarLevels(
  academicYear: string,
  studyLevel: Maybe<StudyLevelFilter>,
): Promise<CalendarLevel[]> {
  return query<CalendarLevel>(
    `SELECT study_level                        AS "studyLevel",
            label,
            semesters->'autumn'->>'from'       AS "autumnFrom",
            semesters->'autumn'->>'to'         AS "autumnTo",
            semesters->'spring'->>'from'       AS "springFrom",
            semesters->'spring'->>'to'         AS "springTo",
            vacation->>'from'                  AS "vacationFrom",
            vacation->>'to'                    AS "vacationTo",
            semester_validation                AS "semesterValidation"
     FROM calendar_levels
     WHERE academic_year = $1
       AND ($2::text IS NULL OR study_level = $2)
     ORDER BY study_level`,
    [academicYear, studyLevel ?? null],
  );
}

export async function findCalendarExamPeriods(
  academicYear: string,
  studyLevel: Maybe<StudyLevelFilter>,
  normalizedQuestion: string,
): Promise<CalendarExamPeriod[]> {
  return query<CalendarExamPeriod>(
    `SELECT l.study_level AS "studyLevel", p.name, p.label,
            p.held_from AS "heldFrom", p.held_to AS "heldTo",
            p.apply_from AS "applyFrom", p.apply_to AS "applyTo"
     FROM calendar_exam_periods p
     JOIN calendar_levels l ON l.id = p.level_id
     WHERE l.academic_year = $1
       AND ($2::text IS NULL OR l.study_level = $2)
       AND (NOT EXISTS (
              SELECT 1 FROM calendar_exam_periods p2
              JOIN calendar_levels l2 ON l2.id = p2.level_id
              WHERE l2.academic_year = $1
                AND word_similarity(p2.name, $3) >= 0.5)
            OR word_similarity(p.name, $3) >= 0.5)
     ORDER BY l.study_level, p.held_from`,
    [academicYear, studyLevel ?? null, normalizedQuestion],
  );
}

export async function findCalendarDays(
  academicYear: string,
  studyLevel: Maybe<StudyLevelFilter>,
): Promise<CalendarDay[]> {
  return query<CalendarDay>(
    `SELECT d.kind, min(d.day) AS "firstDay",
            count(DISTINCT d.day)::int AS days, d.note
     FROM calendar_days d
     JOIN calendar_levels l ON l.id = d.level_id
     WHERE l.academic_year = $1
       AND ($2::text IS NULL OR l.study_level = $2)
     GROUP BY d.kind, d.note
     ORDER BY min(d.day)`,
    [academicYear, studyLevel ?? null],
  );
}

export type CalendarLookup = {
  status: "ok" | "no_match";
  topics: CalendarTopic[];
  context: string;
};

function levelHeading(level: { studyLevel: string }): string {
  return STUDY_LEVEL_LABELS[level.studyLevel] ?? level.studyLevel;
}

function describeLevels(
  levels: CalendarLevel[],
  topics: CalendarTopic[],
): string[] {
  return levels.flatMap((level) => {
    const lines: string[] = [];

    if (topics.includes(CalendarTopic.Semester)) {
      const autumn = formatRange(level.autumnFrom, level.autumnTo);
      const spring = formatRange(level.springFrom, level.springTo);
      if (autumn) lines.push(`- јесењи семестар: ${autumn}`);
      if (spring) lines.push(`- пролећни семестар: ${spring}`);
    }
    if (topics.includes(CalendarTopic.Vacation)) {
      const vacation = formatRange(level.vacationFrom, level.vacationTo);
      if (vacation) lines.push(`- распуст: ${vacation}`);
    }
    if (
      topics.includes(CalendarTopic.SemesterValidation) &&
      level.semesterValidation
    ) {
      lines.push(`- овера семестра: ${level.semesterValidation}`);
    }

    return lines.length > 0 ? [`${levelHeading(level)}:`, ...lines] : [];
  });
}

function describePeriods(
  periods: CalendarExamPeriod[],
  topics: CalendarTopic[],
): string[] {
  if (periods.length === 0) return [];

  const wantsRegistration = topics.includes(CalendarTopic.ExamRegistration);
  const lines: string[] = [];
  let currentLevel = "";

  for (const period of periods) {
    if (period.studyLevel !== currentLevel) {
      currentLevel = period.studyLevel;
      lines.push(`${levelHeading(period)}:`);
    }

    const held = formatRange(period.heldFrom, period.heldTo);
    const apply = formatRange(period.applyFrom, period.applyTo);
    const parts = [held && `одржава се ${held}`];

    if (wantsRegistration) {
      parts.push(apply ? `пријава ${apply}` : "пријава није објављена");
    }

    lines.push(
      `- ${period.label ?? period.name} рок: ${parts.filter(Boolean).join(", ")}`,
    );
  }

  return lines;
}

function describeDays(days: CalendarDay[]): string[] {
  if (days.length === 0) return [];
  return [
    "Радни и нерадни дани:",
    ...days.map(
      (day) =>
        `- ${day.kind === "radni" ? "радни" : "нерадни"}: ` +
        (day.note ?? formatDate(day.firstDay)),
    ),
  ];
}

export async function lookupCalendar(
  question: string,
  academicYear = currentAcademicYear(),
): Promise<CalendarLookup> {
  const normalizedQuestion = toSearchForm(question);
  const topics = detectCalendarTopics(normalizedQuestion);

  if (topics.length === 0) {
    return { status: "no_match", topics, context: "" };
  }

  const studyLevel = detectStudyLevel(normalizedQuestion);
  const wantsPeriods =
    topics.includes(CalendarTopic.ExamPeriod) ||
    topics.includes(CalendarTopic.ExamRegistration);

  const [levels, periods, days] = await Promise.all([
    findCalendarLevels(academicYear, studyLevel),
    wantsPeriods
      ? findCalendarExamPeriods(academicYear, studyLevel, normalizedQuestion)
      : Promise.resolve([]),
    topics.includes(CalendarTopic.Days)
      ? findCalendarDays(academicYear, studyLevel)
      : Promise.resolve([]),
  ]);

  const lines = [
    ...describeLevels(levels, topics),
    ...describePeriods(periods, topics),
    ...describeDays(days),
  ];

  if (lines.length === 0) {
    return { status: "no_match", topics, context: "" };
  }

  return {
    status: "ok",
    topics,
    context: `КАЛЕНДАР АКТИВНОСТИ (школска ${academicYear}):\n${lines.join("\n")}`,
  };
}
