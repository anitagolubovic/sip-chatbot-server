import assert from "node:assert/strict";
import test from "node:test";
import { countTokens } from "../preprocessing";
import {
  buildRetrievalQuery,
  ChatMessage,
  HISTORY_TURNS,
  MAX_HISTORY_TOKENS,
  MAX_MESSAGE_TOKENS,
  trimHistory,
} from "./conversation";

const MODEL = "gpt-4o-mini";

function turns(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => [
    { role: "user" as const, content: `pitanje ${i}` },
    { role: "assistant" as const, content: `odgovor ${i}` },
  ]).flat();
}

test("keeps only the last few turns", () => {
  const kept = trimHistory(turns(10), MODEL);

  assert.equal(kept.length, HISTORY_TURNS * 2);
  assert.equal(kept[0].content, `pitanje ${10 - HISTORY_TURNS}`);
  assert.equal(kept[kept.length - 1].content, "odgovor 9");
});

test("drops empty and system messages", () => {
  const kept = trimHistory(
    [
      { role: "system", content: "ti si asistent" },
      { role: "user", content: "  " },
      { role: "user", content: "kada je ispit" },
      { role: "assistant", content: "Za koji predmet?" },
    ],
    MODEL,
  );

  assert.deepEqual(kept, [
    { role: "user", content: "kada je ispit" },
    { role: "assistant", content: "Za koji predmet?" },
  ]);
});

test("shortens a single long message to its token budget", () => {
  const long = "Прва реченица одговора. ".repeat(200);
  const [kept] = trimHistory([{ role: "assistant", content: long }], MODEL);

  assert.ok(countTokens(kept.content, MODEL) <= MAX_MESSAGE_TOKENS);
  assert.ok(kept.content.endsWith("…"));
});

test("stays inside the total history budget, keeping the newest", () => {
  const long = "Одговор са пуно детаља о роковима. ".repeat(40);
  const history: ChatMessage[] = Array.from(
    { length: HISTORY_TURNS * 2 },
    (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${i} ${long}`,
    }),
  );

  const kept = trimHistory(history, MODEL);
  const used = kept.reduce(
    (sum, message) => sum + countTokens(message.content, MODEL),
    0,
  );

  assert.ok(used <= MAX_HISTORY_TOKENS);
  assert.ok(kept.length < history.length);
  assert.ok(kept[kept.length - 1].content.startsWith(`${history.length - 1} `));
});

test("carries the previous question into a follow-up lookup", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "kada je ispit iz Matematike 1" },
    { role: "assistant", content: "U januarskom roku 5. februara." },
  ];

  assert.equal(
    buildRetrievalQuery("a u junu?", history, MODEL),
    "kada je ispit iz Matematike 1 a u junu?",
  );
  assert.equal(
    buildRetrievalQuery("Да ли важи и за тај рок?", history, MODEL),
    "kada je ispit iz Matematike 1 Да ли важи и за тај рок?",
  );
});

test("answers a counter-question with the original question attached", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "kada je ispit" },
    { role: "assistant", content: "Za koji predmet vas zanima termin?" },
  ];

  assert.equal(
    buildRetrievalQuery("Matematika 1", history, MODEL),
    "kada je ispit Matematika 1",
  );
});

test("leaves a self-contained question alone", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "kada je ispit iz Matematike 1" },
    { role: "assistant", content: "U januarskom roku." },
  ];
  const question = "Koji obrazac se predaje za overu semestra na master studijama?";

  assert.equal(buildRetrievalQuery(question, history, MODEL), question);
  assert.equal(buildRetrievalQuery(question, [], MODEL), question);
});
