import { Category, CATEGORY_LABELS } from "../models/categories";
import { Maybe } from "../models/types";
import { toSearchForm } from "../preprocessing";
import { describeLookup, lookupExams } from "./examQuery";
import { lookupCalendar } from "./calendarQuery";
import { lookupSchedule } from "./scheduleQuery";
import { lookupText } from "./textQuery";
import { isDefined } from "../helper";

type BranchResult = {
  context: string;
  category: Maybe<Category>;
};

type Branch = {
  categories: readonly Category[];
  lookup: (
    question: string,
    category: Maybe<Category>,
  ) => Promise<BranchResult>;
};

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
        category: (lookup.hits[0]?.category as Maybe<Category>) ?? category,
      };
    },
  },
];

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
  // Posle ispita, jer "ispit u drugom semestru" pominje semestar a pita o
  // roku. Pitanje o samom semestru ne sadrzi nijednu rec iz pravila iznad,
  // pa tek ovde bira kalendar. Prati temu Semester iz calendarQuery.
  [
    Category.ActivityCalendar,
    /semestar|semestr|pocetak nastave|nastava pocinje/,
  ],
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

export type RetrievalQuery = {
  // Ide granama u pretragu. Kod nadovezivanja sadrzi i preneto prethodno
  // pitanje, bez kojeg "do kada traje?" nema o cemu da se pretrazi.
  lookup: string;
  // Bira granu: samo ono sto je korisnik zaista pitao.
  routing: string;
};

export type Retrieved = {
  context: string;
  source: Maybe<Category>;
  fromOtherCategory: boolean;
};

const EMPTY: Retrieved = {
  context: "",
  source: null,
  fromOtherCategory: false,
};

// Grana koju je izabralo samo korisnikovo pitanje sme da pretrazuje dopunjeni
// upit, jer joj preneti deo daje predmet ("a raspored casova?" posle pitanja
// o Fizici). Ostale grane dobijaju samo ono sto je korisnik rekao: inace bi
// "kada je ispit?" posle pitanja o raspustu dobilo datume raspusta, jer bi
// kalendar odgovorio na rec iz proslog pitanja. Kada pitanje samo ne nosi
// nijedan signal, i rezervne grane rade nad dopunjenim upitom.
async function search(
  query: RetrievalQuery,
  branches: readonly Branch[],
): Promise<Maybe<{ category: Category; context: string }>> {
  const [preferred, ...rest] = branches;
  const fallback = isDefined(intentFor(query.routing))
    ? query.routing
    : query.lookup;

  const first = isDefined(preferred)
    ? await firstMatch([preferred], query.lookup, null)
    : null;

  return first ?? (await firstMatch(rest, fallback, null));
}

export async function retrieve(
  query: RetrievalQuery,
  category: Maybe<Category>,
): Promise<Retrieved> {
  if (!category) {
    const match = await search(query, orderBranches(query));
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
    ? await selected.lookup(query.lookup, category)
    : null;

  if (selectedResult?.context) {
    return {
      context: selectedResult.context,
      source: category,
      fromOtherCategory: false,
    };
  }

  const others = orderBranches(query).filter(
    (branch) => branch !== selected,
  );
  const match = await search(query, others);

  return match
    ? {
        context: match.context,
        source: match.category,
        fromOtherCategory: true,
      }
    : EMPTY;
}

function intentFor(question: string): Maybe<Category> {
  const normalized = toSearchForm(question);
  return (
    INTENT_RULES.find(([, pattern]) => pattern.test(normalized))?.[0] ??
    null
  );
}

// Granu bira samo korisnikovo pitanje. Preneto prethodno pitanje treba
// pretrazi unutar grane, ali ne sme da bira granu: rec iz prosle teme
// ("prijava", "raspust") odvukla bi novo pitanje na pogresnu granu.
// Kod pravog kontrapitanja ("Matematika 1" na pitanje "koji predmet?")
// original ne nosi nijedan signal, pa tek tada odlucuje dopunjeni upit.
function orderBranches(query: RetrievalQuery): readonly Branch[] {
  const preferred = intentFor(query.routing) ?? intentFor(query.lookup);
  const first = isDefined(preferred) ? branchFor(preferred) : null;

  if (!first) return BRANCHES;
  return [first, ...BRANCHES.filter((branch) => branch !== first)];
}

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

export function describeRetrieved(
  retrieved: Retrieved,
  category: Maybe<Category>,
): string {
  if (!retrieved.context) {
    return isDefined(category)
      ? `The user selected the category "${CATEGORY_LABELS[category]}", for which there are no data available for this question.`
      : "";
  }

  if (!retrieved.fromOtherCategory || !category || !retrieved.source) {
    return retrieved.context;
  }

  return (
    `The user selected the category "${CATEGORY_LABELS[category]}", but the data ` +
    `below comes from the category "${CATEGORY_LABELS[retrieved.source]}"; remind him of this.\n` +
    retrieved.context
  );
}
