import { query } from "../db/pool";
import { ordinalKey, toSearchForm } from "../preprocessing";
import { currentAcademicYear } from "../scraper/lib/scraperRuntime";
import { Maybe } from "../models/types";
import { isDefined } from "../helper";
import {
  detectStudyLevel,
  formatDate,
  STUDY_LEVEL_LABELS,
  today,
  type StudyLevelFilter,
} from "./questionParsing";

const COURSE_MATCH_THRESHOLD = 0.45;
const EXAM_PERIOD_MATCH_THRESHOLD = 0.5;

const AMBIGUITY_MARGIN = 0.15;
const MAX_CANDIDATES = 4;

const MAX_TERMS_WITHOUT_COURSE = 12;

const QUESTION_ORDINALS = /\d+|\b(?:i{2,3}|iv|vi{0,3}|ix|xi{0,2})\b/g;

export type CourseCandidate = {
  courseName: string;
  score: number;
};

export type QuestionFilters = {
  academicYear: string;
  courseName: Maybe<string>;
  candidates: CourseCandidate[];
  examPeriod: Maybe<string>;
  studyLevel: Maybe<StudyLevelFilter>;
};

export type ExamTerm = {
  courseName: string;
  studyLevel: string;
  examPeriod: string;
  examPeriodLabel: string;
  examDate: string;
  examTime: Maybe<string>;
  durationMinutes: Maybe<number>;
  rooms: Maybe<string>;
  /** Satnica roka je objavljena; termin bez sale tada nije u satnici. */
  slotsPublished: boolean;
  accreditations: string;
  semesters: string;
};

function questionOrdinals(normalizedQuestion: string): string {
  return (normalizedQuestion.match(QUESTION_ORDINALS) ?? []).join(".");
}

export async function detectExamPeriod(
  normalizedQuestion: string,
  academicYear: string,
): Promise<Maybe<string>> {
  const rows = await query<{ exam_period: string; score: number }>(
    `SELECT exam_period,
            word_similarity(replace(exam_period, '-', ' '), $1) AS score
     FROM exams
     WHERE academic_year = $2
     GROUP BY exam_period
     ORDER BY score DESC, length(exam_period) DESC
     LIMIT 1`,
    [normalizedQuestion, academicYear],
  );

  const best = rows[0];
  return best && best.score >= EXAM_PERIOD_MATCH_THRESHOLD
    ? best.exam_period
    : null;
}

export async function findCourseCandidates(
  normalizedQuestion: string,
  academicYear: string,
): Promise<CourseCandidate[]> {
  const rows = await query<{
    course_name: string;
    course_name_norm: string;
    score: number;
  }>(
    `SELECT course_name, course_name_norm,
            word_similarity(course_name_norm, $1) AS score
     FROM exams
     WHERE academic_year = $2
     GROUP BY course_name, course_name_norm
     HAVING word_similarity(course_name_norm, $1) >= $3
     ORDER BY score DESC, course_name
     LIMIT 20`,
    [normalizedQuestion, academicYear, COURSE_MATCH_THRESHOLD],
  );

  // "Matematika 1" i "Matematika 2" dobijaju skoro isti rezultat, pa redna
  // oznaka iz pitanja odlucuje umesto razlike u slicnosti.
  const wanted = questionOrdinals(normalizedQuestion);
  const byOrdinal = wanted
    ? rows.filter((row) => ordinalKey(row.course_name_norm) === wanted)
    : rows;
  const matched = byOrdinal.length > 0 ? byOrdinal : rows;

  return matched
    .slice(0, MAX_CANDIDATES)
    .map((row) => ({ courseName: row.course_name, score: Number(row.score) }));
}

/** Predmet je razresen ako je jedini kandidat ili ubedljivo ispred sledeceg. */
export function resolveCourse(candidates: CourseCandidate[]): Maybe<string> {
  const [best, next] = candidates;
  if (!best) return null;
  if (!next || best.score - next.score >= AMBIGUITY_MARGIN) {
    return best.courseName;
  }
  return null;
}

export async function parseExamQuestion(
  question: string,
  academicYear = currentAcademicYear(),
): Promise<QuestionFilters> {
  const normalizedQuestion = toSearchForm(question);
  const [candidates, examPeriod] = await Promise.all([
    findCourseCandidates(normalizedQuestion, academicYear),
    detectExamPeriod(normalizedQuestion, academicYear),
  ]);

  return {
    academicYear,
    courseName: resolveCourse(candidates),
    candidates,
    examPeriod,
    studyLevel: detectStudyLevel(normalizedQuestion),
  };
}

export async function findExamTerms(filters: {
  academicYear: string;
  courseName?: Maybe<string>;
  examPeriod?: Maybe<string>;
  studyLevel?: Maybe<string>;
  fromDate?: Maybe<string>;
  limit?: number;
}): Promise<ExamTerm[]> {
  // Akreditacije 2013 i 2019 dele termin u 99,8% slucajeva, pa se redovi spajaju
  // po terminu, a akreditacija se izdvaja samo da bi se prikazala kad se razlikuje.
  return query<ExamTerm>(
    `SELECT course_name                                              AS "courseName",
            study_level                                              AS "studyLevel",
            exam_period                                              AS "examPeriod",
            exam_period_label                                        AS "examPeriodLabel",
            exam_date                                                AS "examDate",
            exam_time                                                AS "examTime",
            duration_minutes                                         AS "durationMinutes",
            rooms,
            EXISTS (SELECT 1 FROM exams slot
                    WHERE slot.academic_year = $1
                      AND slot.exam_period = exams.exam_period
                      AND slot.rooms IS NOT NULL)                    AS "slotsPublished",
            string_agg(DISTINCT accreditation, '/' ORDER BY accreditation) AS accreditations,
            string_agg(DISTINCT semester, ', ' ORDER BY semester)    AS semesters
     FROM exams
     WHERE academic_year = $1
       AND ($2::text IS NULL OR course_name = $2)
       AND ($3::text IS NULL OR exam_period = $3)
       AND ($4::text IS NULL OR study_level = $4)
       AND ($5::date IS NULL OR exam_date >= $5)
     GROUP BY course_name, study_level, exam_period, exam_period_label,
              exam_date, exam_time, duration_minutes, rooms
     ORDER BY exam_date, course_name, accreditations
     LIMIT $6`,
    [
      filters.academicYear,
      filters.courseName ?? null,
      filters.examPeriod ?? null,
      filters.studyLevel ?? null,
      filters.fromDate ?? null,
      filters.limit ?? 50,
    ],
  );
}

export type ExamLookupStatus =
  /** Termini su nadjeni. */
  | "ok"
  /** Vise predmeta odgovara pitanju, bot treba da pita koji. */
  | "ambiguous"
  /** Predmet je prepoznat, ali za zadate filtere nema termina. */
  | "not_found"
  /** Pitanje ne govori ni o predmetu ni o roku. */
  | "no_match";

export type ExamLookup = {
  status: ExamLookupStatus;
  filters: QuestionFilters;
  terms: ExamTerm[];
  context: string;
  /** Filter nivoa studija je odbacen jer sa njim nije bilo termina. */
  droppedStudyLevel: boolean;
  /** Prikazani termini su prosli, jer buducih u ovoj skolskoj godini nema. */
  onlyPast: boolean;
  /** Lista je skracena jer pitanje nije imenovalo predmet. */
  truncated: boolean;
};

export async function lookupExams(
  question: string,
  academicYear = currentAcademicYear(),
): Promise<ExamLookup> {
  const filters = await parseExamQuestion(question, academicYear);
  const empty = {
    filters,
    terms: [],
    context: "",
    droppedStudyLevel: false,
    onlyPast: false,
    truncated: false,
  };

  if (!filters.courseName) {
    if (filters.candidates.length > 0) {
      return { ...empty, status: "ambiguous" };
    }
    if (!filters.examPeriod) {
      return { ...empty, status: "no_match" };
    }
  }

  const base = {
    academicYear: filters.academicYear,
    courseName: filters.courseName,
    examPeriod: filters.examPeriod,
  };

  const upcoming = filters.examPeriod ? null : today();

  const attempts = [
    { studyLevel: filters.studyLevel, fromDate: upcoming },
    { studyLevel: filters.studyLevel, fromDate: null },
    { studyLevel: null, fromDate: upcoming },
    { studyLevel: null, fromDate: null },
  ].filter(
    (attempt, index, all) =>
      all.findIndex(
        (other) =>
          other.studyLevel === attempt.studyLevel &&
          other.fromDate === attempt.fromDate,
      ) === index,
  );

  const limit = filters.courseName ? undefined : MAX_TERMS_WITHOUT_COURSE + 1;
  let terms: ExamTerm[] = [];
  let used = attempts[0];

  for (const attempt of attempts) {
    terms = await findExamTerms({ ...base, ...attempt, limit });
    used = attempt;
    if (terms.length > 0) break;
  }

  const droppedStudyLevel =
    terms.length > 0 && Boolean(filters.studyLevel) && !used.studyLevel;
  const onlyPast =
    terms.length > 0 && Boolean(upcoming) && used.fromDate === null;

  const truncated = terms.length > MAX_TERMS_WITHOUT_COURSE;
  if (truncated) terms = terms.slice(0, MAX_TERMS_WITHOUT_COURSE);

  return {
    status: terms.length > 0 ? "ok" : "not_found",
    filters,
    terms,
    truncated,
    onlyPast,
    context: formatExamContext(terms),
    droppedStudyLevel,
  };
}

export function describeLookup(lookup: ExamLookup): string {
  if (lookup.status === "ambiguous") {
    const names = lookup.filters.candidates
      .map((candidate) => candidate.courseName)
      .join(", ");
    return (
      `RASPORED ISPITA: pitanju odgovara više predmeta (${names}). ` +
      "Zatraži od korisnika da precizira na koji predmet misli i ponudi mu tačno " +
      "ove nazive. Ne navodi termine dok predmet nije izabran."
    );
  }

  if (lookup.status !== "ok") return "";

  const notes = [
    lookup.droppedStudyLevel &&
      "Predmet ne postoji na nivou studija koji je korisnik naveo; termini su sa " +
        "nivoa navedenog uz naziv predmeta i to mu reci.",
    lookup.onlyPast &&
      "Svi ovi rokovi su već prošli u ovoj školskoj godini; navedi to.",
    lookup.truncated &&
      "Ovo je samo deo termina u roku; predloži korisniku da pita za konkretan predmet.",
    lookup.terms.some(
      (term) => !term.slotsPublished && term.examDate >= today(),
    ) &&
      "Za termine bez sale satnica još nije objavljena; sala se objavljuje pred sam rok.",
    lookup.terms.some((term) => !term.rooms && term.slotsPublished) &&
      "Termin označen kao da nije u satnici ne postoji u objavljenoj satnici roka; " +
        "savetuj korisniku da proveri kod predmetnog nastavnika ili studentske službe.",
  ].filter((note): note is string => typeof note === "string");

  const heading = lookup.filters.examPeriod
    ? `RASPORED ISPITA (školska ${lookup.filters.academicYear}, traženi rok)`
    : `RASPORED ISPITA (školska ${lookup.filters.academicYear}, preostali rokovi)`;

  return (
    `${heading}:\n${lookup.context}` +
    (notes.length > 0 ? `\n${notes.join(" ")}` : "")
  );
}

export function formatExamContext(terms: ExamTerm[]): string {
  if (terms.length === 0) return "";

  const courses = new Set(terms.map((term) => term.courseName));
  const levels = new Set(terms.map((term) => term.studyLevel));
  const lines: string[] = [];

  if (courses.size === 1 && levels.size === 1) {
    const [term] = terms;
    lines.push(
      `${term.courseName} (${STUDY_LEVEL_LABELS[term.studyLevel] ?? term.studyLevel}` +
        `, акредитација ${joinDistinct(terms, "accreditations", "/")}` +
        `, семестар ${joinDistinct(terms, "semesters", ", ")}):`,
    );
    // Akreditacije istog predmeta u istom roku mogu biti u razlicitim salama,
    // pa se tada svaki red oznacava akreditacijom.
    const split = new Set(
      terms
        .filter(
          (item, index) =>
            terms.findIndex(
              (other) => other.examPeriod === item.examPeriod,
            ) !== index,
        )
        .map((item) => item.examPeriod),
    );
    for (const item of terms) {
      lines.push(
        `- ${item.examPeriodLabel} рок` +
          (split.has(item.examPeriod)
            ? ` (акредитација ${item.accreditations})`
            : "") +
          `: ${formatDate(item.examDate)}` +
          (item.examTime ? ` у ${item.examTime}` : " (време није објављено)") +
          formatSlot(item),
      );
    }
    return lines.join("\n");
  }

  for (const term of terms) {
    lines.push(
      `- ${term.courseName} (${STUDY_LEVEL_LABELS[term.studyLevel] ?? term.studyLevel}): ` +
        `${term.examPeriodLabel} рок, ${formatDate(term.examDate)}` +
        (term.examTime ? ` у ${term.examTime}` : "") +
        formatSlot(term),
    );
  }
  return lines.join("\n");
}

function formatSlot(term: ExamTerm): string {
  const duration = isDefined(term.durationMinutes)
    ? `, трајање ${formatDuration(term.durationMinutes)}`
    : "";
  if (!term.rooms) {
    return term.slotsPublished ? " (није у објављеној сатници)" : "";
  }
  return `${duration}, сала: ${term.rooms}`;
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours > 0 && `${hours} h`, rest > 0 && `${rest} min`]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function joinDistinct(
  terms: ExamTerm[],
  field: "accreditations" | "semesters",
  separator: string,
): string {
  const values = new Set(
    terms.flatMap((term) => term[field].split(separator)),
  );
  return [...values].sort().join(separator);
}
