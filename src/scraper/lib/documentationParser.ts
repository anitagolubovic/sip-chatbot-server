import * as cheerio from "cheerio";
import { extractArticle } from "./articleExtractor";
import { absoluteUrl, SITE_ORIGIN } from "./httpClient";
import { parseTextualDate } from "./serbianDates";
import { cleanText, latinSearchText } from "./textNormalization";

export { SITE_ORIGIN };

export const SOURCES = [
  { slug: "obrasci", url: `${SITE_ORIGIN}/category/obrasci` },
  { slug: "das", url: `${SITE_ORIGIN}/category/das` },
  { slug: "mas", url: `${SITE_ORIGIN}/category/mas` },
  {
    slug: "upis-naredne-godine-oas",
    url: `${SITE_ORIGIN}/category/upis-naredne-godine-oas`,
  },
] as const;

export type SourceSlug = (typeof SOURCES)[number]["slug"];
export type Procedure =
  | "upis_godine"
  | "overa_semestra"
  | "ispis_sa_fakulteta"
  | "izbor_predmeta_ili_modula"
  | "obrazac_ili_zahtev"
  | "status_studenta"
  | "zavrsni_rad"
  | "strucna_praksa"
  | "skolarina_ili_uplata"
  | "prijava_ispita";
export type StudyLevel = "OAS" | "MAS" | "DAS" | "SVI";

export type ListingItem = {
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
};

export type Attachment = {
  label: string;
  url: string;
  fileName: string;
  fileType: string;
};

export type ParsedArticle = {
  text: string;
  paragraphs: string[];
  listItems: string[];
  attachments: Attachment[];
  internalLinks: Array<{ label: string; url: string }>;
};

const FILE_EXTENSION = /\.(pdf|docx?|xlsx?|rtf|odt|zip)(?:$|\?)/i;
const ACADEMIC_YEAR = /(20\d{2})\s*[\/\-–]\s*(20\d{2}|\d{2})/g;

function publicationDateIn(
  $: cheerio.CheerioAPI,
  item: cheerio.Cheerio<import("domhandler").AnyNode>,
): { date: string; element: import("domhandler").AnyNode | null } | null {
  for (const element of item.find("time[datetime]").toArray()) {
    const datetime = $(element).attr("datetime") ?? "";
    const iso = /^(20\d{2}-\d{2}-\d{2})/.exec(datetime)?.[1];
    if (iso) return { date: iso, element };
  }

  const candidates = item
    .find("time, p, small, span")
    .toArray()
    .map((element) => ({ element, text: cleanText($(element).text()) }))
    .filter(({ text }) => text.length > 0 && text.length < 160)
    .sort((a, b) => {
      const metadataScore = (text: string) =>
        (/\d{1,2}:\d{2}/.test(text) ? 2 : 0) +
        (/^(?:пон|уто|сре|чет|пет|суб|нед)/iu.test(text) ? 1 : 0);
      return (
        metadataScore(b.text) - metadataScore(a.text) ||
        a.text.length - b.text.length
      );
    });

  for (const candidate of candidates) {
    const date = parseTextualDate(cleanText(candidate.text));
    if (date) return { date, element: candidate.element };
  }
  return null;
}

export function parseListing(html: string): ListingItem[] {
  const $ = cheerio.load(html);
  const result: ListingItem[] = [];
  const seen = new Set<string>();
  const semanticScope = $("main, [role='main']");
  const scope = semanticScope.length ? semanticScope : $("body");

  scope.find("li").each((_, element) => {
    const item = $(element);
    const heading = item.find("h1, h2, h3, h4, h5, h6").first();
    const link = heading.find("a[href]").first().length
      ? heading.find("a[href]").first()
      : item.find("a[href]").first();
    const title = cleanText(heading.text()) || cleanText(link.text());
    const url = absoluteUrl(link.attr("href"));
    const publication = publicationDateIn($, item);
    if (!title || !url || !publication) return;

    if (seen.has(url)) return;
    seen.add(url);

    const summaryElement = item
      .find("p")
      .toArray()
      .find(
        (paragraph) =>
          paragraph !== publication.element &&
          (!publication.element ||
            !$(publication.element)
              .parents()
              .toArray()
              .some((parent) => parent === paragraph)),
      );
    result.push({
      title,
      summary: summaryElement ? cleanText($(summaryElement).text()) : "",
      url,
      publishedAt: publication.date,
    });
  });
  return result;
}

export function hasNextPage(html: string, currentPage: number): boolean {
  const $ = cheerio.load(html);
  return $("a[href]")
    .toArray()
    .some((element) => {
      const match = /[?&]page=(\d+)/.exec($(element).attr("href") ?? "");
      return Boolean(match && Number(match[1]) > currentPage);
    });
}

export function normalizeAcademicYear(input: string): string | null {
  const match = /^(20\d{2})\s*[\/\-–]\s*(20\d{2}|\d{2})$/.exec(input.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
  return end === start + 1 ? `${start}/${end}` : null;
}

export function academicYearsIn(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(ACADEMIC_YEAR)) {
    const start = Number(match[1]);
    const end = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
    if (end === start + 1) result.push(`${start}/${end}`);
  }
  return [...new Set(result)];
}

export function calendarYearInTitle(title: string): number | null {
  return calendarYearsIn(title)[0] ?? null;
}

export function calendarYearsIn(text: string): number[] {
  const withoutAcademicYear = text.replace(ACADEMIC_YEAR, " ");
  const result = [
    ...withoutAcademicYear.matchAll(/(?:^|\D)(20\d{2})(?!\d)/g),
  ].map((match) => Number(match[1]));
  return [...new Set(result)];
}

const HARD_EXCLUSIONS = [
  /\braspored\w*\s+(?:casova|ispita|kolokvijuma)/i,
  /\bkalendar\w*\s+aktivnosti/i,
  /\bizmen\w*\s+u\s+kalendar/i,
  /\blinkov\w*\s+za\s+pristup/i,
  /\bkonsultativn\w*\s+nastav/i,
  /\brealizacij\w*\s+nastave/i,
  /\bplan\w*\s+izvodjenja\s+nastave/i,
  /\bkreiranj\w*\s+(?:sip\s+)?naloga/i,
  /\bpromocij\w*\s+(?:novog\s+)?program/i,
  /\brang\s+list/i,
  /\bvrednovanj\w*\s+kvaliteta\s+nastav/i,
];

const PROCEDURES: Array<{ procedure: Procedure; patterns: RegExp[] }> = [
  {
    procedure: "overa_semestra",
    patterns: [/\bover\w*\s+(?:jesenjeg\s+|prolecnog\s+)?semestra/i],
  },
  {
    procedure: "ispis_sa_fakulteta",
    patterns: [/\bispis\w*\s+sa\s+fakulteta/i, /\bispisnic\w*/i],
  },
  {
    procedure: "izbor_predmeta_ili_modula",
    patterns: [
      /\bizborn\w*\s+predmet/i,
      /\bizbor\w*\s+(?:predmeta|modula)/i,
      /\blist\w*\s+izbornih/i,
      /\bbira\w*\s+modul/i,
    ],
  },
  {
    procedure: "upis_godine",
    patterns: [
      /\bupis\w*\s+(?:samofinansirajucih\s+)?studenata\b/i,
      /\bupis\w*\s+(?:studenata\s+)?(?:u\s+)?(?:i{1,3}|iv|\d+)?\s*godin/i,
      /\bupis\w*\s+(?:nove|naredne|vise)\s+(?:skolske\s+)?godine/i,
      /\bponovni\s+upis/i,
      /\buslovi\s+upisa/i,
      /\brok\s+za\s+upis/i,
    ],
  },
  {
    procedure: "status_studenta",
    patterns: [/\bproduzenj\w*\s+statusa/i, /\bmirovanj\w*/i],
  },
  {
    procedure: "zavrsni_rad",
    patterns: [/\bzavrsn\w*\s+rad/i, /\bdiplomsk\w*\s+rad/i, /\bmaster\s+rad/i],
  },
  {
    procedure: "strucna_praksa",
    patterns: [/\bstrucn\w*\s+praks/i],
  },
  {
    procedure: "skolarina_ili_uplata",
    patterns: [
      /\bskolarin\w*/i,
      /\buplatnic\w*/i,
      /\boslobadj\w*\s+(?:od\s+)?placanja/i,
      /\bnaknad\w*\s+za/i,
    ],
  },
  {
    procedure: "prijava_ispita",
    patterns: [/\bprijav\w*\s+ispita/i],
  },
  {
    procedure: "obrazac_ili_zahtev",
    patterns: [
      /\bobrasc\w*/i,
      /\bobrazac\b/i,
      /\bzahtev\w*/i,
      /\bdokumentacij\w*/i,
      /\bprijavn\w*\s+list/i,
    ],
  },
];

/**
 * Namerno klasifikuje samo naslov i kratak opis sa liste. Telo clanka moze da
 * pominje raspored, upis ili druge teme usput i zato ne sme da odredi namenu.
 */
export function classifyRelevant(title: string, summary: string): Procedure[] {
  const searchable = latinSearchText(`${title} ${summary}`);
  if (HARD_EXCLUSIONS.some((pattern) => pattern.test(searchable))) return [];
  return PROCEDURES.filter(({ patterns }) =>
    patterns.some((pattern) => pattern.test(searchable)),
  ).map(({ procedure }) => procedure);
}

export function inferStudyLevels(
  source: SourceSlug,
  title: string,
  text: string,
): StudyLevel[] {
  const searchable = latinSearchText(`${title} ${text.slice(0, 500)}`);
  const levels: StudyLevel[] = [];
  if (/\boas\b|osnovn\w*\s+akademsk/i.test(searchable)) levels.push("OAS");
  if (/\bmas\b|master\w*\s+akademsk/i.test(searchable)) levels.push("MAS");
  if (/\bdas\b|doktor\w*\s+akademsk/i.test(searchable)) levels.push("DAS");
  if (levels.length) return levels;
  if (source === "mas") return ["MAS"];
  if (source === "das") return ["DAS"];
  if (source === "upis-naredne-godine-oas") return ["OAS"];
  return ["SVI"];
}

export function parseArticle(html: string, pageUrl: string): ParsedArticle {
  // Datum objave je metapodatak sa listinga. Ne sme da ucini trajni obrazac
  // godisnjim dokumentom samo zato sto je objavljen, na primer, 2019. godine.
  const article = extractArticle(html, pageUrl);
  const attachments: Attachment[] = [];
  const internalLinks: Array<{ label: string; url: string }> = [];

  for (const { label, url } of article.links) {
    const extension = FILE_EXTENSION.exec(url);
    if (extension) {
      attachments.push({
        label,
        url,
        fileName: decodeURIComponent(url.split("/").pop() ?? "").split("?")[0],
        fileType: extension[1].toLowerCase(),
      });
    } else if (url.startsWith(`${SITE_ORIGIN}/article/`)) {
      internalLinks.push({ label, url });
    }
  }

  return {
    text: article.text,
    paragraphs: article.paragraphs,
    listItems: article.listItems,
    attachments,
    internalLinks,
  };
}
