import type {
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

export type {
  ClassType,
  Day,
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
  byClassType: Record<string, number>;
  ocrCells: number;
  lowConfidenceCells: number;
};

export type ClassScheduleDocument = DataDocument<"raspored_casova"> & {
  studyLevel: StudyLevel;
  studyLevelLabel: string;
  semester: number;
  studyYear: number;
  semesterType: SemesterType;
  module: string | null;
  submodule: string | null;
  moduleLabel: string | null;
  source: ScheduleSourceRef;
  legend: ScheduleLegendInfo;
  timeRows: ScheduleTimeRow[];
  counts: ScheduleCounts;
  groupRooms?: GroupRooms;
  indexGroups?: { sourceUrl: string; ranges: IndexGroupRange[] };
  warnings: string[];
  scheduleByDay: Partial<Record<Day, ScheduleEntry[]>>;
  schedule: ScheduleEntry[];
};

export type ClassScheduleIndexEntry = {
  studyLevel: StudyLevel;
  semester: number;
  studyYear: number;
  semesterType: SemesterType;
  module: string | null;
  submodule: string | null;
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
