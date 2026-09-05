import { toSearchForm } from "../preprocessing";
import { Maybe } from "./types";

/** Kategorije koje korisnik moze da izabere na frontu. Vrednosti su iste kao
 * polje `category` u prikupljenim JSON dokumentima. */
export enum Category {
  ExamSchedule = "polaganje_ispita",
  ActivityCalendar = "kalendar_aktivnosti",
  ClassSchedule = "raspored_casova",
  Documentation = "studentska_dokumentacija",
  Opportunities = "konkursi_i_promovisane_aktivnosti",
}

export const CATEGORY_LABELS: { [category in Category]: string } = {
  [Category.ExamSchedule]: "Polaganje ispita",
  [Category.ActivityCalendar]: "Kalendar aktivnosti",
  [Category.ClassSchedule]: "Raspored časova",
  [Category.Documentation]: "Dokumentacija i administracija",
  [Category.Opportunities]: "Stipendije, konkursi i razmene studenata",
};

// Front moze da posalje i slug i naziv dugmeta, pa se prepoznaju oba. Redosled
// je bitan: "polaganje ispita" mora da se proveri pre "rasporeda", jer se u
// nazivu "raspored ispita" pojavljuju obe reci.
const CATEGORY_PATTERNS: ReadonlyArray<[Category, RegExp]> = [
  [Category.ExamSchedule, /ispit|polaganj/],
  [Category.ActivityCalendar, /kalendar/],
  [Category.ClassSchedule, /raspored|casov|nastav/],
  [Category.Documentation, /dokument|administrac|obraz|obras/],
  [Category.Opportunities, /konkurs|stipendij|razmen/],
];

/**
 * Prepoznaje kategoriju iz vrednosti koju posalje front, bez obzira na to da li
 * je poslat slug, naziv dugmeta, cirilica ili latinica. Vraca null za nepoznatu
 * ili nepostavljenu vrednost, sto znaci "korisnik nije izabrao kategoriju".
 */
export function resolveCategory(value: Maybe<string>): Maybe<Category> {
  if (!value) return null;

  const normalized = toSearchForm(value);
  if (!normalized) return null;

  const exact = Object.values(Category).find(
    (category) => toSearchForm(category.replace(/_/g, " ")) === normalized,
  );
  if (exact) return exact;

  return (
    CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ??
    null
  );
}
