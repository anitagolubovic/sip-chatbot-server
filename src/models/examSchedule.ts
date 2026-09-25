import type { DataDocument } from "./common";
import { Maybe } from "./types";

export type ExamEntry = {
  studyLevel: string;
  accreditation: string;
  semester: string;
  module: string;
  courseCode: string;
  courseName: string;
  date: Maybe<string>;
  time: Maybe<string>;
};

export type ExamPeriodResult = {
  name: string;
  label: string;
  pdfUrl: string;
  exams: ExamEntry[];
};

export type ExamScheduleDocument = DataDocument<"polaganje_ispita"> & {
  sourceUrl: string;
  generatedAt: string;
  examPeriods: ExamPeriodResult[];
};

/** Red satnice: tacan termin ispita sa salama, objavljen pred sam rok. */
export type ExamSlot = {
  studyLevel: Maybe<string>;
  courseCode: string;
  courseName: string;
  date: Maybe<string>;
  time: Maybe<string>;
  durationMinutes: Maybe<number>;
  rooms: Maybe<string>;
};

export type ExamSlotPage = {
  /** Isti naziv roka kao ExamPeriodResult.name, po njemu se satnica spaja sa rasporedom. */
  examPeriod: string;
  title: string;
  url: string;
  publishedAt: string;
  slots: ExamSlot[];
};

export type ExamSlotsDocument = DataDocument<"satnica_ispita"> & {
  sourceUrl: string;
  /** Poredjano po datumu objave, pa kasnija izmena satnice pregazi raniju. */
  pages: ExamSlotPage[];
};
