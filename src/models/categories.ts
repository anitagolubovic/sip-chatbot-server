import { isDefined, isNotDefined } from "../helper";
import { toSearchForm } from "../preprocessing";
import { Maybe } from "./types";

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

const CATEGORY_PATTERNS: ReadonlyArray<[Category, RegExp]> = [
  [Category.ExamSchedule, /ispit|polaganj/],
  [Category.ActivityCalendar, /kalendar/],
  [Category.ClassSchedule, /raspored|casov|nastav/],
  [Category.Documentation, /dokument|administrac|obraz|obras/],
  [Category.Opportunities, /konkurs|stipendij|razmen/],
];

export function resolveCategory(value: Maybe<string>): Maybe<Category> {
  if (isNotDefined(value)) return null;

  const normalized = toSearchForm(value);
  if (!normalized) return null;

  const exact: Maybe<Category> = Object.values(Category).find(
    (category) => toSearchForm(category.replace(/_/g, " ")) === normalized,
  );
  if (isDefined(exact)) return exact;

  return (
    CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ??
    null
  );
}
