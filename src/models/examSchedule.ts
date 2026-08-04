import type { DataDocument } from "./common";

export type ExamEntry = {
  studyLevel: string;
  accreditation: string;
  semester: string;
  module: string;
  courseCode: string;
  courseName: string;
  date: string | null;
  time: string | null;
};

export type RokResult = {
  rok: string;
  label: string;
  pdfUrl: string;
  exams: ExamEntry[];
};

export type ExamScheduleDocument = DataDocument<"polaganje_ispita"> & {
  sourceUrl: string;
  rokovi: RokResult[];
};
