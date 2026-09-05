import { Category, CATEGORY_LABELS } from "../models/categories";
import { Maybe } from "../models/types";
import { toSearchForm } from "../preprocessing";
import { describeLookup, lookupExams } from "./examQuery";
import { lookupCalendar } from "./calendarQuery";
import { lookupSchedule } from "./scheduleQuery";
import { lookupText } from "./textQuery";

/** Prazan kontekst znaci da grana nema odgovor na pitanje. */
type BranchResult = {
  context: string;
  /** Kategorija iz koje je podatak; grana koja pokriva vise njih javlja tacnu. */
  category: Maybe<Category>;
};

/** Jedna grana podataka: pitanje unutra, kontekst napolje. */
type Branch = {
  /** Kategorije sa fronta koje ova grana pokriva. */
  categories: readonly Category[];
  lookup: (
    question: string,
    category: Maybe<Category>,
  ) => Promise<BranchResult>;
};

/**
 * Podrazumevani redosled pretrage. Strukturirane grane idu prve jer su
 * deterministicne i besplatne; tekstualna je poslednja jer svako njeno
 * pokretanje trazi embedding pitanja, dakle poziv modelu.
 */
const BRANCHES: readonly Branch[] = [
  {
    categories: [Category.ExamSchedule],
    lookup: async (question) => ({
      context: describeLookup(await lookupExams(question)),
      category: Category.ExamSchedule,
    }),
  },
  {
    categories: [Category.ClassSchedule],
    lookup: async (question) => ({
      context: (await lookupSchedule(question)).context,
      category: Category.ClassSchedule,
    }),
  },
  {
    categories: [Category.ActivityCalendar],
    lookup: async (question) => ({
      context: (await lookupCalendar(question)).context,
      category: Category.ActivityCalendar,
    }),
  },
  {
    categories: [Category.Documentation, Category.Opportunities],
    lookup: async (question, category) => {
      const lookup = await lookupText(question, category);
      return {
        context: lookup.context,
        // Bez izabrane kategorije obe se pretrazuju, pa kategoriju odredjuje
        // najbolji pogodak.
        category: (lookup.hits[0]?.category as Maybe<Category>) ?? category,
      };
    },
  },
];

/**
 * Kad korisnik nije izabrao kategoriju, redosled grana odredjuje pitanje. Prvo
 * pravilo koje se poklopi odlucuje; ostale grane zadrzavaju podrazumevani red.
 * Kalendar je ispred ispita jer "prijava ispita" i "overa semestra" sadrze reci
 * koje bi inace povukle granu rasporeda ispita.
 */
const INTENT_RULES: ReadonlyArray<[Category, RegExp]> = [
  [
    Category.Opportunities,
    /stipendij|konkurs|razmen|praks|kamp|takmicenj|hakaton|obuk|radionic/,
  ],
  [
    Category.Documentation,
    /uverenj|potvrd|obraz|obras|zahtev|molb|dokument|upis|ispis|prepis|diplom|skolarin/,
  ],
  [
    Category.ActivityCalendar,
    /prijav|overa|overi|raspust|praznik|neradn|kalendar aktivnosti/,
  ],
  [Category.ExamSchedule, /ispit|polaganj|\brok/],
  [
    Category.ClassSchedule,
    /\bcas|predavanj|vezb|sala|ucionic|raspored casova|imam|ponedelj|utor|sred|cetvrt|petak|subot/,
  ],
];

function branchFor(category: Category): Maybe<Branch> {
  return (
    BRANCHES.find((branch) => branch.categories.includes(category)) ?? null
  );
}

function orderBranches(question: string): readonly Branch[] {
  const normalized = toSearchForm(question);
  const preferred = INTENT_RULES.find(([, pattern]) =>
    pattern.test(normalized),
  )?.[0];
  const first = preferred ? branchFor(preferred) : null;

  if (!first) return BRANCHES;
  return [first, ...BRANCHES.filter((branch) => branch !== first)];
}

export type Retrieved = {
  context: string;
  /** Grana iz koje podatak zaista dolazi; null kad nista nije nadjeno. */
  source: Maybe<Category>;
  /** Korisnik je izabrao jednu kategoriju, a odgovor dolazi iz druge. */
  fromOtherCategory: boolean;
};

const EMPTY: Retrieved = {
  context: "",
  source: null,
  fromOtherCategory: false,
};

async function firstMatch(
  branches: readonly Branch[],
  question: string,
  category: Maybe<Category>,
): Promise<Maybe<{ category: Category; context: string }>> {
  for (const branch of branches) {
    const result = await branch.lookup(question, category);
    if (result.context) {
      return {
        category: result.category ?? branch.categories[0],
        context: result.context,
      };
    }
  }
  return null;
}

/**
 * Cinjenice za pitanje. Izabrana kategorija se gleda prva; ako u njoj nema
 * odgovora, pitanje ide kroz preostale grane, da pogresno izabrana kategorija
 * ne sakrije podatak koji postoji.
 */
export async function retrieve(
  question: string,
  category: Maybe<Category>,
): Promise<Retrieved> {
  if (!category) {
    const match = await firstMatch(orderBranches(question), question, null);
    return match
      ? {
          context: match.context,
          source: match.category,
          fromOtherCategory: false,
        }
      : EMPTY;
  }

  const selected = branchFor(category);
  const selectedResult = selected
    ? await selected.lookup(question, category)
    : null;

  if (selectedResult?.context) {
    return {
      context: selectedResult.context,
      source: category,
      fromOtherCategory: false,
    };
  }

  const others = orderBranches(question).filter(
    (branch) => branch !== selected,
  );
  const match = await firstMatch(others, question, null);

  return match
    ? {
        context: match.context,
        source: match.category,
        fromOtherCategory: true,
      }
    : EMPTY;
}

/** Kontekst spreman za sistemski prompt, sa napomenama o poreklu podatka. */
export function describeRetrieved(
  retrieved: Retrieved,
  category: Maybe<Category>,
): string {
  if (!retrieved.context) {
    return category
      ? `Korisnik je izabrao kategoriju "${CATEGORY_LABELS[category]}", za koju nema podataka o ovom pitanju.`
      : "";
  }

  if (!retrieved.fromOtherCategory || !category || !retrieved.source) {
    return retrieved.context;
  }

  return (
    `Korisnik je izabrao kategoriju "${CATEGORY_LABELS[category]}", ali podaci ` +
    `ispod dolaze iz kategorije "${CATEGORY_LABELS[retrieved.source]}"; napomeni mu to.\n` +
    retrieved.context
  );
}
