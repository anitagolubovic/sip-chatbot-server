import { extractArticle } from "./articleExtractor";
import {
  hasNextPage,
  normalizeAcademicYear,
  parseListing,
  type ListingItem,
} from "./documentationParser";
import { latinSearchText } from "./textNormalization";

export { hasNextPage, normalizeAcademicYear, parseListing, type ListingItem };

export const ACTIVITY_SOURCES = [
  {
    slug: "kursevi",
    url: "https://sip.elfak.ni.ac.rs/category/kursevi",
  },
  {
    slug: "konkursi",
    url: "https://sip.elfak.ni.ac.rs/category/konkursi",
  },
  {
    slug: "ostalo",
    url: "https://sip.elfak.ni.ac.rs/category/ostalo",
  },
] as const;

export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]["slug"];
export type ActivityType =
  | "praksa"
  | "kurs"
  | "stipendija"
  | "razmena_ili_mobilnost"
  | "radionica"
  | "takmicenje_ili_hakaton"
  | "kamp"
  | "predavanje_tribina_ili_konferencija"
  | "studentski_program"
  | "zaposlenje";

export type ResourceLink = {
  label: string;
  url: string;
  kind: "dokument" | "spoljni_link" | "sip_stranica";
};

export type ActivityArticle = {
  paragraphs: string[];
  listItems: string[];
  resources: ResourceLink[];
  text: string;
};

const HARD_EXCLUSIONS = [
  /\bisplat\w*\s+(?:stipendija|studentskih|prve\s+rate)/i,
  /\burucen\w*\s+stipendij/i,
  /\bpotpisivanj\w*\s+ugovora/i,
  /\bpovracaj\w*\s+.*skolarin/i,
  /\bodrzavanj\w*\s+(?:moodle|platforme|sistema)/i,
  /\bdodel\w*\s+diplom/i,
  /\bobavestenj\w*\s+za\s+studente/i,
  /\brezultat\w*\s+konkursa/i,
  /\brang\s+list/i,
];

const TYPE_RULES: Array<{ type: ActivityType; patterns: RegExp[] }> = [
  { type: "praksa", patterns: [/\bpraks\w*/i, /\binternship\b/i] },
  { type: "kurs", patterns: [/\bkurs\w*/i, /\bobuk\w*/i] },
  {
    type: "stipendija",
    patterns: [/\bstipendij\w*/i, /\bstipendiranj\w*/i],
  },
  {
    type: "razmena_ili_mobilnost",
    patterns: [/\berasmus\b/i, /\bmobilnost\w*/i, /\brazmen\w*/i],
  },
  {
    type: "radionica",
    patterns: [/\bradionic\w*/i, /\bworkshop\b/i],
  },
  {
    type: "takmicenje_ili_hakaton",
    patterns: [
      /\btakmicenj\w*/i,
      /\bcompetition\b/i,
      /\bhackathon\b/i,
      /\bhakaton\w*/i,
      /\bcase\s+study\b/i,
      /\bbubble\s+cup\b/i,
    ],
  },
  { type: "kamp", patterns: [/\bkamp\w*/i] },
  {
    type: "predavanje_tribina_ili_konferencija",
    patterns: [
      /\bpredavanj\w*/i,
      /\btribin\w*/i,
      /\bkonferencij\w*/i,
      /\bprezentacij\w*/i,
      /\botvoren\w*\s+vrata/i,
      /\bbazar\w*/i,
    ],
  },
  {
    type: "studentski_program",
    patterns: [
      /\bstudentsk\w*\s+program/i,
      /\bprogram\w*\s+(?:za|podrske|unapredjenj)/i,
      /\bakcelerator\w*\s+program/i,
      /\bstudent\s+experience\b/i,
    ],
  },
  {
    type: "zaposlenje",
    patterns: [/\bpozicij\w*/i, /\bzaposlenj\w*/i, /\bposao\b/i, /\bjob\b/i],
  },
];

export function classifyActivity(
  title: string,
  summary: string,
): ActivityType[] {
  const searchable = latinSearchText(`${title} ${summary}`);
  if (HARD_EXCLUSIONS.some((pattern) => pattern.test(searchable))) return [];
  return TYPE_RULES.filter(({ patterns }) =>
    patterns.some((pattern) => pattern.test(searchable)),
  ).map(({ type }) => type);
}

export function academicYearWindow(academicYear: string): {
  from: string;
  to: string;
} {
  const start = Number(academicYear.slice(0, 4));
  return { from: `${start}-10-01`, to: `${start + 1}-09-30` };
}

export function belongsToAcademicYear(
  item: ListingItem,
  academicYear: string,
): boolean {
  const window = academicYearWindow(academicYear);
  const explicit = [
    ...`${item.title} ${item.summary} ${item.url}`.matchAll(
      /(20\d{2})\s*[\/\-–]\s*(20\d{2}|\d{2})/g,
    ),
  ].map((match) => {
    const start = Number(match[1]);
    const end = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
    return end === start + 1 ? `${start}/${end}` : null;
  });
  if (explicit.some(Boolean)) return explicit.includes(academicYear);
  return item.publishedAt >= window.from && item.publishedAt <= window.to;
}

const FILE_EXTENSION = /\.(pdf|docx?|xlsx?|pptx?|zip|rtf|odt)(?:$|\?)/i;

export function parseActivityArticle(
  html: string,
  pageUrl: string,
): ActivityArticle {
  const article = extractArticle(html, pageUrl);
  const resources = article.links.map(
    ({ label, url }): ResourceLink => ({
      label,
      url,
      kind: FILE_EXTENSION.test(url)
        ? "dokument"
        : url.startsWith("https://sip.elfak.ni.ac.rs/")
          ? "sip_stranica"
          : "spoljni_link",
    }),
  );

  return {
    paragraphs: article.paragraphs,
    listItems: article.listItems,
    resources,
    text: article.text,
  };
}
