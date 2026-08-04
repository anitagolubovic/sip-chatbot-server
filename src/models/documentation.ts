import type {
  Attachment,
  Procedure,
  SourceSlug,
  StudyLevel,
} from "../scraper/lib/documentationParser";
import type { DataDocument } from "./common";

export type { Attachment, Procedure, SourceSlug };
export type { StudyLevel as DocumentationStudyLevel };

export type TemporalScope = "skolska_godina" | "kalendarska_godina" | "opste";

export type RelatedPage = { label: string; url: string };

export type DocumentationRecord = {
  procedureTypes: Procedure[];
  studyLevels: StudyLevel[];
  temporalScope: TemporalScope;
  academicYear: string | null;
  calendarYear: number | null;
  title: string;
  summary: string;
  publishedAt: string;
  sourceCategory: SourceSlug;
  sourceUrl: string;
  content: { paragraphs: string[]; listItems: string[] };
  attachments: Attachment[];
  relatedRelevantPages: RelatedPage[];
};

export type DocumentationDocument = DataDocument<"studentska_dokumentacija"> & {
  records: DocumentationRecord[];
};
