import cron from "node-cron";
import { scrapeOpportunities } from "./scraper/scrapeOpportunities";
import { scrapeDocumentation } from "./scraper/scrapeDocumentation";
import { scrapeActivityCalendar } from "./scraper/scrapeActivityCalendar";
import { scrapeExamSchedule } from "./scraper/scrapeExamSchedule";
import { scrapeClassSchedules } from "./scraper/scrapeClassSchedules";
import { terminateOcr } from "./scraper/lib/ocrService";
import { currentAcademicYear } from "./scraper/lib/scraperRuntime";
import { ingestExams } from "./db/ingestExams";
import { ingestCalendar } from "./db/ingestCalendar";
import { ingestSchedules } from "./db/ingestSchedules";
import { ingestTextual } from "./db/ingestTextual";
import { embedChunks } from "./db/embedChunks";

enum ScraperTask {
  ClassSchedules = "raspored časova",
  ActivityCalendar = "kalendar aktivnosti",
  ExamSchedule = "raspored ispita",
  Opportunities = "konkursi i aktivnosti",
  Documentation = "dokumentacija",
  IngestSchedules = "upis rasporeda časova u bazu",
  IngestCalendar = "upis kalendara u bazu",
  IngestExams = "upis rasporeda ispita u bazu",
  IngestTextual = "upis dokumentacije i konkursa u bazu",
  Embed = "embedovanje tekstualnih delova",
}

const cronExpression = process.env.SIP_SCRAPER_CRON ?? "15 3 * * *";
let running = false;

async function run(): Promise<void> {
  if (running) {
    console.warn(
      "[SIP scraper] The previous run is still in progress, skipping this run.",
    );
    return;
  }

  running = true;
  try {
    const academicYear = currentAcademicYear(new Date());

    console.log(`[SIP scraper] Updating data for ${academicYear}.`);

    // Svaki upis u bazu ide odmah posle svog scrapera, u istoj petlji: ako
    // scraper ne uspe, JSON fajl ostaje kakav je bio, a upis ga ponovo
    // proveri i preskoci (hes se nije promenio) umesto da pukne.
    const tasks: Array<[ScraperTask, () => Promise<void>]> = [
      [ScraperTask.ClassSchedules, () => scrapeClassSchedules()],
      [ScraperTask.IngestSchedules, () => ingestSchedules(academicYear)],
      [
        ScraperTask.ActivityCalendar,
        () => scrapeActivityCalendar(academicYear),
      ],
      [ScraperTask.IngestCalendar, () => ingestCalendar(academicYear)],
      [ScraperTask.ExamSchedule, () => scrapeExamSchedule(academicYear)],
      [ScraperTask.IngestExams, () => ingestExams(academicYear)],
      [ScraperTask.Opportunities, () => scrapeOpportunities(academicYear)],
      [ScraperTask.Documentation, () => scrapeDocumentation(academicYear)],
      [ScraperTask.IngestTextual, () => ingestTextual(academicYear)],
      [ScraperTask.Embed, () => embedChunks()],
    ];

    const failed: ScraperTask[] = [];

    for (const [name, task] of tasks) {
      try {
        await task();
      } catch (error) {
        failed.push(name);
        console.error(
          `[SIP scraper] "${name}" not updated:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    try {
      await terminateOcr();
    } catch (error) {
      console.error(
        "[SIP scraper] OCR worker not terminated:",
        error instanceof Error ? error.message : error,
      );
    }

    console.log(
      failed.length === 0
        ? "[SIP scraper] All data is up to date."
        : `[SIP scraper] Failed: ${failed.join(", ")}.`,
    );
  } finally {
    running = false;
  }
}

void run();

if (!process.argv.includes("--once")) {
  cron.schedule(cronExpression, run, {
    timezone: "Europe/Belgrade",
    noOverlap: true,
  });
}
