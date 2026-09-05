import type { StudyLevel } from "../scraper/lib/scheduleDiscovery";
import type { DataDocument } from "./common";

export type { StudyLevel };

export type Period = { from: string | null; to: string | null; raw: string };

export type DayNote = { dates: string[]; note: string; raw: string };

export type ExamSitting = Period & {
  name: string;
  examRegistration: Period | null;
};

export type ExamPeriod = {
  name: string;
  label: string;
  held: Period;
  examRegistration: Period | null;
  sittings: ExamSitting[];
};

export type Calendar = {
  studyLevel: StudyLevel;
  label: string;
  sourceUrl: string;
  pdfUrl: string | null;
  semesters: { autumn: Period | null; spring: Period | null };
  vacation: Period | null;
  semesterValidation: string | null;
  workingDays: DayNote[];
  nonWorkingDaysAndHolidays: DayNote[];
  examPeriods: ExamPeriod[];
  notes: string[];
  rawText: string;
};


export type ActivityCalendarDocument = DataDocument<"kalendar_aktivnosti"> & {
  levels: Calendar[];
};
