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
