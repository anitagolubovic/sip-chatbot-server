import { scrapeClassSchedules } from "./scrapeClassSchedules";
(async () => {
  await scrapeClassSchedules();
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
