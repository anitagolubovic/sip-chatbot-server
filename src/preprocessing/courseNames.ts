import { isDefined } from "../helper";
import { toSearchForm } from "./transliterate";
import { findMixedScriptWords } from "./unicode";

export const MAX_NAME_DISTANCE = 1;

export function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = previous[j];
      previous[j] =
        a[i - 1] === b[j - 1]
          ? diagonal
          : 1 + Math.min(diagonal, previous[j], previous[j - 1]);
      diagonal = current;
    }
  }
  return previous[b.length];
}

const ORDINALS = /\d+|\b[ivx]+\b/g;

type NameGroup = {
  norm: string;
  comparable: string;
  ordinals: string;
  count: number;
  spellings: Map<string, number>;
};

export function canonicalCourseNames(
  names: readonly string[],
): Map<string, string> {
  const leaders: NameGroup[] = [];
  const canonical = new Map<string, string>();

  for (const group of groupByNormalizedForm(names)) {
    const leader = leaders.find(
      (candidate) =>
        candidate.ordinals === group.ordinals &&
        levenshteinDistance(candidate.comparable, group.comparable) <=
          MAX_NAME_DISTANCE,
    );

    if (isDefined(leader)) {
      leader.count += group.count;
      for (const [spelling, count] of group.spellings) {
        leader.spellings.set(
          spelling,
          (leader.spellings.get(spelling) ?? 0) + count,
        );
      }
    } else {
      leaders.push(group);
    }
  }

  for (const leader of leaders) {
    const chosen = preferredSpelling(leader);
    for (const spelling of leader.spellings.keys()) {
      canonical.set(spelling, chosen);
    }
  }

  return canonical;
}

function groupByNormalizedForm(names: readonly string[]): NameGroup[] {
  const groups = new Map<string, NameGroup>();

  for (const name of names) {
    const norm = toSearchForm(name);
    const group = groups.get(norm) ?? {
      norm,
      comparable: collapseSeparators(norm),
      ordinals: ordinalKey(norm),
      count: 0,
      spellings: new Map<string, number>(),
    };
    group.count += 1;
    group.spellings.set(name, (group.spellings.get(name) ?? 0) + 1);
    groups.set(norm, group);
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.norm.localeCompare(b.norm),
  );
}

function collapseSeparators(name: string): string {
  return name.replace(/[-–—]/g, " ").replace(/\s+/g, " ").trim();
}

export function ordinalKey(name: string): string {
  return (name.match(ORDINALS) ?? []).join(".");
}

function preferredSpelling(group: NameGroup): string {
  return [...group.spellings.entries()].sort(
    (a, b) =>
      findMixedScriptWords(a[0]).length - findMixedScriptWords(b[0]).length ||
      b[1] - a[1] ||
      a[0].localeCompare(b[0]),
  )[0][0];
}
