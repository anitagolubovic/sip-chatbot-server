import cron from "node-cron";
import { scrapeOpportunities } from "./scraper/scrapeOpportunities";
import { scrapeDocumentation } from "./scraper/scrapeDocumentation";
import { scrapeActivityCalendar } from "./scraper/scrapeActivityCalendar";
import { scrapeExamSchedule } from "./scraper/scrapeExamSchedule";
import { scrapeClassSchedules } from "./scraper/scrapeClassSchedules";
import { terminateOcr } from "./scraper/lib/ocrService";
import { currentAcademicYear } from "./scraper/lib/scraperRuntime";

const cronExpression = process.env.SIP_SCRAPER_CRON ?? "15 3 * * *";
let running = false;

async function run(): Promise<void> {
  if (running) {
    console.warn("[SIP scraper] Prethodno ažuriranje još traje; preskačem.");
    return;
  }

  running = true;
  const academicYear = currentAcademicYear(new Date());
  console.log(`[SIP scraper] Ažuriram podatke za ${academicYear}.`);

  // Svaki scraper se izvršava zasebno: ako SIP promeni jednu stranicu, ostali
  // podaci se svejedno osveže.
  const tasks: Array<[string, () => Promise<void>]> = [
    ["raspored časova", () => scrapeClassSchedules()],
    ["kalendar aktivnosti", () => scrapeActivityCalendar(academicYear)],
    ["raspored ispita", () => scrapeExamSchedule(academicYear)],
    ["konkursi i aktivnosti", () => scrapeOpportunities(academicYear)],
    ["dokumentacija", () => scrapeDocumentation(academicYear)],
  ];

  const failed: string[] = [];
  for (const [name, task] of tasks) {
    try {
      await task();
    } catch (error) {
      failed.push(name);
      console.error(
        `[SIP scraper] "${name}" nije ažuriran:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  await terminateOcr();
  running = false;
  console.log(
    failed.length === 0
      ? "[SIP scraper] Sve je ažurirano."
      : `[SIP scraper] Neuspešno: ${failed.join(", ")}.`,
  );
}

void run();
if (!process.argv.includes("--once")) {
  cron.schedule(cronExpression, run, {
    timezone: "Europe/Belgrade",
    noOverlap: true,
  });
  console.log(
    `[SIP scraper] Cron: ${cronExpression} (Europe/Belgrade)`,
  );
}
