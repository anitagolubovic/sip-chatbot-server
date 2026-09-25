import type {
  FirstYearEntry,
  GroupRooms,
  IndexGroupRange,
} from "../scraper/lib/firstYearSchedule";
import type {
  IndexPage,
  SemesterType,
  StudyLevel,
} from "../scraper/lib/scheduleDiscovery";
import type { ScheduleEntry } from "../scraper/lib/scheduleEntryExtractor";
import type { Day } from "../scraper/lib/scheduleGrid";
import type { ClassType } from "../scraper/lib/scheduleLegend";
import type { DataDocument } from "./common";
import { Maybe } from "./types";

export type {
  ClassType,
  Day,
  FirstYearEntry,
  GroupRooms,
  IndexGroupRange,
  IndexPage,
  ScheduleEntry,
  SemesterType,
  StudyLevel,
};

export type ScheduleTimeRow = { fromTime: string; toTime: string };

export type ScheduleLegendInfo = {
  lectureFill: string;
  hasLabEntry: boolean;
  labels: string[];
};

export type ScheduleSourceRef = {
  pageUrl: string;
  pdfUrl: string;
  pdfSha256: string;
  linkText: string;
};

export type ScheduleCounts = {
  entries: number;
  ocrCells: number;
  lowConfidenceCells: number;
};

// Rasporedi prve godine OAS prolaze kroz enrichFirstYearEntries, koji dodaje
// razresene grupe i sale po grupi; ostali rasporedi ta polja ne nose.
export type ScheduleDocumentEntry = ScheduleEntry &
  Partial<Pick<FirstYearEntry, "groups" | "roomsByGroup">>;

export type ClassScheduleDocument = DataDocument<"raspored_casova"> & {
  studyLevel: StudyLevel;
  studyLevelLabel: string;
  semester: number;
  studyYear: number;
  semesterType: SemesterType;
  module: Maybe<string>;
  submodule: Maybe<string>;
  moduleLabel: Maybe<string>;
  source: ScheduleSourceRef;
  legend: ScheduleLegendInfo;
  timeRows: ScheduleTimeRow[];
  counts: ScheduleCounts;
  groupRooms?: GroupRooms;
  indexGroups?: { sourceUrl: string; ranges: IndexGroupRange[] };
  warnings: string[];
  scheduleByDay: Partial<Record<Day, ScheduleDocumentEntry[]>>;
  schedule: ScheduleDocumentEntry[];
};

export type ClassScheduleIndexEntry = {
  studyLevel: StudyLevel;
  semester: number;
  studyYear: number;
  semesterType: SemesterType;
  module: Maybe<string>;
  submodule: Maybe<string>;
  academicYear: string;
  pdfUrl: string;
  file: string;
  entries: number;
  ocrCells: number;
  lowConfidenceCells: number;
};

export type ClassScheduleFailure = { pdfUrl: string; message: string };

export type ClassScheduleIndex = {
  generatedAt: string;
  indexPages: IndexPage[];
  total: number;
  succeeded: number;
  failed: number;
  schedules: ClassScheduleIndexEntry[];
  failures: ClassScheduleFailure[];
};
