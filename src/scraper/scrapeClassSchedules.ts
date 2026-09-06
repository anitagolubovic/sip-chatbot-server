import crypto from "crypto";
import path from "path";
import {
  extractEntries,
  type ScheduleEntry,
} from "./lib/scheduleEntryExtractor";
import {
  discoverSources,
  INDEX_PAGES,
  type ScheduleSource,
} from "./lib/scheduleDiscovery";
import { fetchPdf } from "./lib/httpClient";
import {
  enrichFirstYearEntries,
  fetchIndexGroups,
  GROUPS_PAGE_URL,
  isFirstYearOas,
  parseGroupRooms,
  type IndexGroupRange,
} from "./lib/firstYearSchedule";
import { assertGeometryIsConsistent, buildGrid } from "./lib/scheduleGrid";
import { parseHeader } from "./lib/scheduleHeader";
import { parseLegend } from "./lib/scheduleLegend";
import { terminateOcr } from "./lib/ocrService";
import { loadPdfPage } from "./lib/pdfPageLoader";
import { DATA_DIR, runCli, writeJson } from "./lib/scraperRuntime";
import type {
  ClassScheduleDocument,
  ClassScheduleFailure,
  ClassScheduleIndex,
} from "../models/classSchedule";
import { Maybe } from "../models/types";
import { isDefined } from "../helper";

const OUTPUT_DIR = path.join(DATA_DIR, "raspored-casova");
const INDEX_FILE = path.join(OUTPUT_DIR, "index.json");
const RENDER_SCALE = 6;

type ScrapedSchedule = {
  source: ScheduleSource;
  outputFile: string;
  entries: number;
  ocrCells: number;
  lowConfidenceCells: number;
};

export async function scrapeClassSchedules(): Promise<void> {
  const sources = await discoverSources(INDEX_PAGES);

  const lexicon = new Set<string>();
  const results: ScrapedSchedule[] = [];
  const failures: ClassScheduleFailure[] = [];

  let indexGroups: Maybe<IndexGroupRange[]> = null;
  if (
    sources.some((source) => isFirstYearOas(source.studyLevel, source.semester))
  ) {
    try {
      indexGroups = await fetchIndexGroups();
    } catch (error) {
      console.warn(
        `  WARNING: index to group mapping not read: ${
          error instanceof Error ? error.message : error
        }\n`,
      );
    }
  }

  for (const source of sources) {
    const label = [
      source.studyLevel === "osnovne_akademske" ? "OAS" : "MAS",
      `${source.semester}. semestar`,
      source.module ?? "svi moduli",
      source.submodule ?? "",
    ]
      .filter(Boolean)
      .join(" / ");

    try {
      const result = await scrapeSource(source, lexicon, indexGroups);
      results.push(result);
      console.log(
        `OK   ${label.padEnd(38)} termina=${String(result.entries).padStart(3)} ` +
          `OCR=${String(result.ocrCells).padStart(2)}` +
          (result.lowConfidenceCells > 0
            ? ` (nesigurnih=${result.lowConfidenceCells})`
            : ""),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ pdfUrl: source.pdfUrl, message });
      console.error(`ERROR ${label}: ${message}`);
    }
  }

  const index: ClassScheduleIndex = {
    generatedAt: new Date().toISOString(),
    indexPages: INDEX_PAGES,
    total: sources.length,
    succeeded: results.length,
    failed: failures.length,
    schedules: results.map((result) => ({
      studyLevel: result.source.studyLevel,
      semester: result.source.semester,
      studyYear: result.source.studyYear,
      semesterType: result.source.semesterType,
      module: result.source.module,
      submodule: result.source.submodule,
      academicYear: result.source.academicYear,
      pdfUrl: result.source.pdfUrl,
      file: path.basename(result.outputFile),
      entries: result.entries,
      ocrCells: result.ocrCells,
      lowConfidenceCells: result.lowConfidenceCells,
    })),
    failures,
  };
  writeJson(INDEX_FILE, index);

  const totalEntries = results.reduce((sum, item) => sum + item.entries, 0);
  console.log(
    `\Success: ${results.length}/${sources.length} schedules: ${totalEntries}`,
  );
  console.log(`Output: ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    console.error(`Unsuccessful: ${failures.length}`);
  }
}

async function scrapeSource(
  source: ScheduleSource,
  lexicon: Set<string>,
  indexGroups: Maybe<IndexGroupRange[]>,
): Promise<ScrapedSchedule> {
  const pdf: Buffer<ArrayBufferLike> = await fetchPdf(source.pdfUrl);
  const pdfSha256 = crypto.createHash("sha256").update(pdf).digest("hex");

  const page = await loadPdfPage(pdf);
  try {
    const grid = buildGrid(page.shapes, page.textItems);
    assertGeometryIsConsistent(grid, page.textItems);

    const legend = parseLegend(page.textItems, page.shapes, grid.table);
    const header = parseHeader(page.textItems, grid.table);

    const warnings: string[] = [];
    if (isDefined(header.semester) && header.semester !== source.semester) {
      warnings.push(
        `Different semester in header (${header.semester}) than expected (${source.semester}).`,
      );
    }
    if (
      isDefined(header.academicYear) &&
      header.academicYear !== source.academicYear
    ) {
      warnings.push(
        `Different academic year in header (${header.academicYear}) than expected (${source.academicYear}).`,
      );
    }

    const canvas = await page.render(RENDER_SCALE);
    let { entries, ocrCells, lowConfidenceCells, unknownFills } =
      await extractEntries({
        grid,
        shapes: page.shapes,
        textItems: page.textItems,
        legend,
        pageCanvas: canvas,
        pageHeight: page.height,
        lexicon,
      });

    if (entries.length === 0) {
      throw new Error("No schedule entries could be extracted from the PDF.");
    }

    if (unknownFills.length > 0) {
      warnings.push(
        `Unknown fill colors in schedule entries: ${unknownFills.join(", ")}.`,
      );
    }

    let groupRooms = null as Maybe<ReturnType<typeof parseGroupRooms>>;
    if (isFirstYearOas(source.studyLevel, source.semester)) {
      groupRooms = parseGroupRooms(page.textItems, grid);

      if (
        Object.keys(groupRooms.lectures).length === 0 ||
        Object.keys(groupRooms.exercises).length === 0
      ) {
        warnings.push(
          "No group-to-room mapping could be extracted from the PDF for first-year OAS schedule entries.",
        );
      } else {
        const enriched = enrichFirstYearEntries(entries, groupRooms);
        entries = enriched.entries;
        if (enriched.withoutGroup > 0) {
          warnings.push(
            `${enriched.withoutGroup}  first-year OAS schedule entries could not be assigned to any group.`,
          );
        }
      }
    }

    const byDay: Record<string, ScheduleEntry[]> = {};
    for (const entry of entries) {
      (byDay[entry.day] ??= []).push(entry);
    }

    const output: ClassScheduleDocument = {
      schemaVersion: 2,
      category: "raspored_casova",
      language: "sr-Cyrl",
      studyLevel: source.studyLevel,
      studyLevelLabel:
        source.studyLevel === "osnovne_akademske"
          ? "Основне академске студије"
          : "Мастер академске студије",
      semester: source.semester,
      studyYear: source.studyYear,
      semesterType: source.semesterType,
      module: source.module,
      submodule: source.submodule,
      moduleLabel: header.moduleLabel,
      academicYear: source.academicYear,
      generatedAt: new Date().toISOString(),
      source: {
        pageUrl: source.pageUrl,
        pdfUrl: source.pdfUrl,
        pdfSha256,
        linkText: source.linkText,
      },
      legend: {
        lectureFill: legend.lectureFill,
        hasLabEntry: legend.hasLabEntry,
        labels: legend.labels,
      },
      timeRows: grid.timeRows.map(({ fromTime, toTime }) => ({
        fromTime,
        toTime,
      })),
      counts: {
        entries: entries.length,
        ocrCells,
        lowConfidenceCells,
      },
      ...(groupRooms
        ? {
            groupRooms,
            indexGroups: {
              sourceUrl: GROUPS_PAGE_URL,
              ranges: indexGroups ?? [],
            },
          }
        : {}),
      warnings,
      scheduleByDay: byDay,
      schedule: entries,
    };

    const outputFile = path.join(OUTPUT_DIR, resolveOutputFileName(source));
    writeJson(outputFile, output);

    return {
      source,
      outputFile,
      entries: entries.length,
      ocrCells,
      lowConfidenceCells,
    };
  } finally {
    await page.destroy();
  }
}

function resolveOutputFileName(source: ScheduleSource): string {
  const level = source.studyLevel === "osnovne_akademske" ? "oas" : "mas";
  const parts = [
    level,
    `sem${source.semester}`,
    source.module?.toLowerCase(),
    source.submodule?.toLowerCase(),
    source.academicYear.replace("/", "-"),
  ].filter(Boolean);
  return `${parts.join("-")}.json`;
}

if (require.main === module) {
  runCli(async () => {
    try {
      await scrapeClassSchedules();
    } finally {
      await terminateOcr();
    }
  }, "Error during class schedule scraping");
}
