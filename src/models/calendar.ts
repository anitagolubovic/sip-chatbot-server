import type { StudyLevel } from "../scraper/lib/scheduleDiscovery";
import type { DataDocument } from "./common";

export type { StudyLevel };

export type Period = { od: string | null; do: string | null; raw: string };

export type Dan = { datumi: string[]; napomena: string; raw: string };

export type Polaganje = Period & {
  naziv: string;
  prijavaIspita: Period | null;
};

export type IspitniRok = {
  naziv: string;
  labela: string;
  odrzavanje: Period;
  prijavaIspita: Period | null;
  polaganja: Polaganje[];
};

export type Kalendar = {
  studyLevel: StudyLevel;
  label: string;
  sourceUrl: string;
  pdfUrl: string | null;
  semestri: { jesenji: Period | null; prolecni: Period | null };
  raspust: Period | null;
  overaSemestra: string | null;
  radniDani: Dan[];
  neradniDaniIPraznici: Dan[];
  ispitniRokovi: IspitniRok[];
  napomene: string[];
  rawText: string;
};


export type ActivityCalendarDocument = DataDocument<"kalendar_aktivnosti"> & {
  levels: Kalendar[];
};
