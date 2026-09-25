import type { StudyLevel } from "../scraper/lib/scheduleDiscovery";
import type { DataDocument } from "./common";
import { Maybe } from "./types";

export type { StudyLevel };

export type Period = { from: Maybe<string>; to: Maybe<string>; raw: string };

export type DayNote = { dates: string[]; note: string; raw: string };

export type ExamSitting = Period & {
  name: string;
  examRegistration: Maybe<Period>;
};

export type ExamPeriod = {
  name: string;
  label: string;
  held: Period;
  examRegistration: Maybe<Period>;
  sittings: ExamSitting[];
};

export type Calendar = {
  studyLevel: StudyLevel;
  label: string;
  sourceUrl: string;
  pdfUrl: Maybe<string>;
  semesters: { autumn: Maybe<Period>; spring: Maybe<Period> };
  vacation: Maybe<Period>;
  semesterValidation: Maybe<string>;
  workingDays: DayNote[];
  nonWorkingDaysAndHolidays: DayNote[];
  examPeriods: ExamPeriod[];
  notes: string[];
  rawText: string;
};

export type ActivityCalendarDocument = DataDocument<"kalendar_aktivnosti"> & {
  levels: Calendar[];
};
