import { countTokens, toSearchForm } from "../preprocessing";
import { isDefined, isNotDefined } from "../helper";
import { Maybe } from "../models/types";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: "system" | ChatRole;
  content: string;
};

export const HISTORY_TURNS = 3;
export const MAX_HISTORY_TOKENS = 600;
export const MAX_MESSAGE_TOKENS = 160;
const MAX_CARRIED_TOKENS = 40;

const SHORT_QUESTION_WORDS = 4;

const FOLLOW_UP_START =
  /^(a|i|ali|pa|sta|kada|kad|gde|koliko|zasto|jel|je li|da li|to|taj|ta|te|onda|jos|takodje)\b/;

const REFERENCE_WORD =
  /\b(taj|ta|to|te|ti|tog|toga|tom|tim|njega|njemu|njen|njegov|isti|ista|isto|prethodn|pomenut|njih)\b/;

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

function isUsable(message: Maybe<ChatMessage>): message is ChatMessage {
  return (
    isDefined(message) &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  );
}

export function dropRepeatedQuestion(
  history: Maybe<ChatMessage[]>,
  question: string,
): ChatMessage[] {
  if (isNotDefined(history)) {
    return [];
  }

  const usable = history.filter(isUsable);
  const last = usable[usable.length - 1];

  return isDefined(last) &&
    last.role === "user" &&
    toSearchForm(last.content) === toSearchForm(question)
    ? usable.slice(0, -1)
    : usable;
}

export function buildRetrievalQuery(
  question: string,
  history: readonly ChatMessage[],
  model: Maybe<string> = process.env.OPENAI_MODEL,
): string {
  const previous = getUserPreviousQuestion(history);

  if (isNotDefined(previous) || !isFollowUp(question)) {
    return question;
  }
  return `${clampToTokens(previous, MAX_CARRIED_TOKENS, model)} ${question}`;
}

function getUserPreviousQuestion(
  history: readonly ChatMessage[],
): Maybe<string> {
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

function clampToTokens(
  text: string,
  maxTokens: number,
  model: Maybe<string>,
): string {
  if (countTokens(text, model) <= maxTokens) {
    return text;
  }

  let cut = text;

  while (cut.length > 0 && countTokens(cut, model) > maxTokens) {
    const ratio = maxTokens / countTokens(cut, model);
    cut = cut.slice(0, Math.max(1, Math.floor(cut.length * ratio * 0.95)));
  }

  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
