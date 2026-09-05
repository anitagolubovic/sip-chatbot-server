import { toSearchForm } from "./transliterate";
import { findMixedScriptWords } from "./unicode";

export const MAX_NAME_DISTANCE = 1;

export function levenshtein(a: string, b: string): number {
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

// "Matematika 1" i "Matematika 2" su razliciti predmeti, kao i "Engleski jezik I"
// i "Engleski jezik II". Nazivi sa razlicitim rednim oznakama se nikada ne spajaju.
const ORDINALS = /\d+|\b[ivx]+\b/g;

export function ordinalKey(name: string): string {
  return (name.match(ORDINALS) ?? []).join(".");
}

// Crtica i razmak se u nazivima koriste naizmenicno ("objektno-orijentisano" i
// "objektno orijentisano"), pa ne treba da se racunaju kao razlika.
function collapseSeparators(name: string): string {
  return name.replace(/[-–—]/g, " ").replace(/\s+/g, " ").trim();
}

type NameGroup = {
  norm: string;
  comparable: string;
  ordinals: string;
  count: number;
  spellings: Map<string, number>;
};

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

  // Cesci oblik je kanonski; izjednacene slucajeve resava azbucni redosled da bi
  // rezultat bio isti pri svakom pokretanju.
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.norm.localeCompare(b.norm),
  );
}

// Zapis sa mesanim pismom ("SCАDА" sa cirilicnim A) je greska u izvoru, pa gubi
// od ciste varijante i onda kad je cesci. Tek zatim odlucuje ucestalost.
function preferredSpelling(group: NameGroup): string {
  return [...group.spellings.entries()].sort(
    (a, b) =>
      findMixedScriptWords(a[0]).length - findMixedScriptWords(b[0]).length ||
      b[1] - a[1] ||
      a[0].localeCompare(b[0]),
  )[0][0];
}

/**
 * Spaja pravopisne varijante istog predmeta i vraca mapu
 * sirovi naziv -> kanonski naziv. Nazivi koji se ne spajaju sa jacim oblikom
 * ostaju sami sebi kanonski, pa mapa pokriva sve ulazne nazive.
 */
export function canonicalCourseNames(
  names: readonly string[],
): Map<string, string> {
  const leaders: NameGroup[] = [];
  const canonical = new Map<string, string>();

  for (const group of groupByNormalizedForm(names)) {
    const leader = leaders.find(
      (candidate) =>
        candidate.ordinals === group.ordinals &&
        levenshtein(candidate.comparable, group.comparable) <=
          MAX_NAME_DISTANCE,
    );

    if (leader) {
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
