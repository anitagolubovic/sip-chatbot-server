import { countTokens, toSearchForm } from "../preprocessing";
import { isNotDefined } from "../helper";
import { Maybe } from "../models/types";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: "system" | ChatRole;
  content: string;
};

/**
 * Koliko poruka razgovora se salje modelu. Tri para pitanje-odgovor pokrivaju
 * kontrapitanje i jedno-dva nadovezivanja, a to je sve sto se u praksi koristi;
 * starije poruke bi samo trosile ulazne tokene.
 */
export const HISTORY_TURNS = 3;

/** Gornja granica za celu istoriju, bez obzira na broj poruka. */
export const MAX_HISTORY_TOKENS = 600;

/**
 * Granica za jednu poruku. Odgovori bota su najduzi deo istorije, a za
 * nastavak razgovora dovoljan je njihov pocetak.
 */
export const MAX_MESSAGE_TOKENS = 160;

/** Deo prethodnog pitanja koji se dodaje upitu ka bazi. */
const MAX_CARRIED_TOKENS = 40;

/** Pitanje krace od ovoga skoro uvek se oslanja na prethodnu poruku. */
const SHORT_QUESTION_WORDS = 4;

/**
 * Pocetak nadovezivanja ("a u junu?", "i za master?") i zamenice koje upucuju
 * na vec pomenuti pojam. Uporedjuje se sa `toSearchForm()` oblikom, dakle bez
 * dijakritike i u latinici.
 */
const FOLLOW_UP_START =
  /^(a|i|ali|pa|sta|kada|kad|gde|koliko|zasto|jel|je li|da li|to|taj|ta|te|onda|jos|takodje)\b/;

const REFERENCE_WORD =
  /\b(taj|ta|to|te|ti|tog|toga|tom|tim|njega|njemu|njen|njegov|isti|ista|isto|prethodn|pomenut|njih)\b/;

/** Skracivanje na budzet tokena, po granici reci kad je moguce. */
function clampToTokens(
  text: string,
  maxTokens: number,
  model: Maybe<string>,
): string {
  if (countTokens(text, model) <= maxTokens) {
    return text;
  }

  let cut = text;
  // Odnos tokena i znakova zavisi od pisma, pa se duzina smanjuje u nekoliko
  // koraka umesto jednim deljenjem.
  while (cut.length > 0 && countTokens(cut, model) > maxTokens) {
    const ratio = maxTokens / countTokens(cut, model);
    cut = cut.slice(0, Math.max(1, Math.floor(cut.length * ratio * 0.95)));
  }

  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function isUsable(message: Maybe<ChatMessage>): message is ChatMessage {
  return (
    !isNotDefined(message) &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  );
}

/**
 * Istorija spremna za slanje modelu: bez sistemskih i praznih poruka, samo
 * poslednjih nekoliko razmena, svaka poruka skracena i sve zajedno unutar
 * budzeta tokena. Kad budzet ne dozvoljava sve, ispadaju najstarije poruke.
 */
export function trimHistory(
  history: Maybe<ChatMessage[]>,
  model: Maybe<string> = process.env.OPENAI_MODEL,
): ChatMessage[] {
  if (isNotDefined(history) || history.length === 0) {
    return [];
  }

  const recent = history
    .filter(isUsable)
    .slice(-HISTORY_TURNS * 2)
    .map(({ role, content }) => ({
      role,
      content: clampToTokens(content.trim(), MAX_MESSAGE_TOKENS, model),
    }));

  const kept: ChatMessage[] = [];
  let used = 0;

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const cost = countTokens(recent[i].content, model);
    if (used + cost > MAX_HISTORY_TOKENS) {
      break;
    }
    used += cost;
    kept.unshift(recent[i]);
  }

  return kept;
}

/** Poslednje korisnikovo pitanje pre trenutnog. */
function previousQuestion(history: readonly ChatMessage[]): Maybe<string> {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === "user") {
      return history[i].content;
    }
  }
  return null;
}

function isFollowUp(question: string): boolean {
  const normalized = toSearchForm(question).replace(/[^\p{L}\p{N} ]+/gu, " ");
  const words = normalized.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return false;
  }
  return (
    words.length <= SHORT_QUESTION_WORDS ||
    FOLLOW_UP_START.test(normalized) ||
    REFERENCE_WORD.test(normalized)
  );
}

/**
 * Upit za pretragu baze. Kad se pitanje oslanja na razgovor ("a u junu?",
 * "Matematika 1" kao odgovor na kontrapitanje), samo po sebi nema dovoljno
 * reci za pretragu, pa mu se pridruzuje prethodno pitanje. Ovo je lokalno
 * spajanje teksta i ne trosi nijedan token modela.
 */
export function buildRetrievalQuery(
  question: string,
  history: readonly ChatMessage[],
  model: Maybe<string> = process.env.OPENAI_MODEL,
): string {
  const previous = previousQuestion(history);

  if (isNotDefined(previous) || !isFollowUp(question)) {
    return question;
  }
  return `${clampToTokens(previous, MAX_CARRIED_TOKENS, model)} ${question}`;
}
