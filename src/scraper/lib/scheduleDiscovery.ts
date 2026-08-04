import * as cheerio from "cheerio";
import { absoluteUrl, fetchHtml } from "./httpClient";

export type StudyLevel = "osnovne_akademske" | "master_akademske";
export type SemesterType = "zimski" | "letnji";

export type ScheduleSource = {
  studyLevel: StudyLevel;
  semester: number;
  studyYear: number;
  semesterType: SemesterType;
  module: string | null;
  submodule: string | null;
  academicYear: string;
  pageUrl: string;
  pdfUrl: string;
  linkText: string;
};

export type IndexPage = {
  url: string;
  studyLevel: StudyLevel;
  semesterType: SemesterType;
  academicYear: string;
};

export const INDEX_PAGES: IndexPage[] = [
  {
    url: "https://sip.elfak.ni.ac.rs/article/nastava/raspored-casova-oas-jesen-2025-2026",
    studyLevel: "osnovne_akademske",
    semesterType: "zimski",
    academicYear: "2025/2026",
  },
  {
    url: "https://sip.elfak.ni.ac.rs/article/mas/raspored-casova-jesen-mas-2025-2026",
    studyLevel: "master_akademske",
    semesterType: "zimski",
    academicYear: "2025/2026",
  },
  {
    url: "https://sip.elfak.ni.ac.rs/article/nastava/raspored-casova-oas-prolece-2025-2026",
    studyLevel: "osnovne_akademske",
    semesterType: "letnji",
    academicYear: "2025/2026",
  },
  {
    url: "https://sip.elfak.ni.ac.rs/article/mas/raspored-casova-mas-prolece-2025-2026",
    studyLevel: "master_akademske",
    semesterType: "letnji",
    academicYear: "2025/2026",
  },
];

function parseFileName(pdfUrl: string): {
  semester: number;
  module: string | null;
  submodule: string | null;
} | null {
  const fileName = pdfUrl.split("/").pop() ?? "";
  const match = /^\d+-(?:sem|mas)(\d+)((?:-[a-z0-9]+)*?)(?:-v\d+)?\.pdf$/i.exec(
    fileName,
  );
  if (!match) {
    return null;
  }

  const parts = match[2].split("-").filter(Boolean);
  return {
    semester: Number.parseInt(match[1], 10),
    module: parts[0] ? parts[0].toUpperCase() : null,
    submodule: parts[1] ? parts[1].toUpperCase() : null,
  };
}

export async function discoverSources(
  pages: IndexPage[] = INDEX_PAGES,
): Promise<ScheduleSource[]> {
  const sources: ScheduleSource[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const html = await fetchHtml(page.url);
    const $ = cheerio.load(html);

    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      if (!href || !/\.pdf(?:$|\?)/i.test(href)) {
        return;
      }

      const pdfUrl = absoluteUrl(href);
      if (!pdfUrl || seen.has(pdfUrl)) {
        return;
      }
      seen.add(pdfUrl);

      const parsed = parseFileName(pdfUrl);
      if (!parsed) {
        console.warn(`  Preskacem link nepoznatog oblika: ${pdfUrl}`);
        return;
      }

      const studyYear =
        page.studyLevel === "master_akademske"
          ? 1
          : Math.ceil(parsed.semester / 2);

      sources.push({
        studyLevel: page.studyLevel,
        semester: parsed.semester,
        studyYear,
        semesterType: page.semesterType,
        module: parsed.module,
        submodule: parsed.submodule,
        academicYear: page.academicYear,
        pageUrl: page.url,
        pdfUrl,
        linkText: $(element).text().replace(/\s+/g, " ").trim(),
      });
    });
  }

  return sources;
}
