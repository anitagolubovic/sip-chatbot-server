export type DataDocument<TCategory extends string> = {
  schemaVersion: number;
  category: TCategory;
  language: string;
  academicYear: string;
  generatedAt: string;
};
