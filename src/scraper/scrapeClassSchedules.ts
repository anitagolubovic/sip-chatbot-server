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
import { loadPage } from "./lib/pdfPageLoader";
import { DATA_DIR, runCli, writeJson } from "./lib/scraperRuntime";
import type {
  ClassScheduleDocument,
  ClassScheduleFailure,
  ClassScheduleIndex,
} from "../models/classSchedule";

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

function outputFileName(source: ScheduleSource): string {
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

function summarize(entries: ScheduleEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.classType] = (counts[entry.classType] ?? 0) + 1;
  }
  return counts;
}

async function scrapeSource(
  source: ScheduleSource,
  lexicon: Set<string>,
  indexGroups: IndexGroupRange[] | null,
): Promise<ScrapedSchedule> {
  const pdf = await fetchPdf(source.pdfUrl);
  const pdfSha256 = crypto.createHash("sha256").update(pdf).digest("hex");

  const page = await loadPage(pdf);
  const grid = buildGrid(page.shapes, page.textItems);
  assertGeometryIsConsistent(grid, page.textItems);

  const legend = parseLegend(page.textItems, page.shapes, grid.table);
  const header = parseHeader(page.textItems, grid.table);

  const warnings: string[] = [];
  if (header.semester !== null && header.semester !== source.semester) {
    warnings.push(
      `Semestar iz zaglavlja (${header.semester}) se razlikuje od semestra iz naziva fajla (${source.semester}).`,
    );
  }
  if (header.academicYear && header.academicYear !== source.academicYear) {
    warnings.push(
      `Skolska godina iz zaglavlja (${header.academicYear}) se razlikuje od ocekivane (${source.academicYear}).`,
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
    throw new Error("Iz tabele nije izvucen nijedan termin.");
  }

  if (unknownFills.length > 0) {
    warnings.push(
      `Popune ${unknownFills.join(", ")} nema u legendi; ti termini su ` +
        'oznaceni kao "ostali_casovi" i treba ih rucno proveriti.',
    );
  }

  let groupRooms = null as ReturnType<typeof parseGroupRooms> | null;
  if (isFirstYearOas(source.studyLevel, source.semester)) {
    groupRooms = parseGroupRooms(page.textItems, grid);

    if (
      Object.keys(groupRooms.lectures).length === 0 ||
      Object.keys(groupRooms.exercises).length === 0
    ) {
      warnings.push(
        'Iz kolone "Напомена" nije procitano mapiranje grupa na sale, ' +
          "pa termini prve godine ostaju bez sala.",
      );
    } else {
      const enriched = enrichFirstYearEntries(entries, groupRooms);
      entries = enriched.entries;
      if (enriched.withoutGroup > 0) {
        warnings.push(
          `${enriched.withoutGroup} termina prve godine nema prepoznatu grupu, pa ni salu.`,
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
      byClassType: summarize(entries),
      ocrCells,
      lowConfidenceCells,
    },
    // Popunjeno samo za prvu godinu OAS-a.
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

  const outputFile = path.join(OUTPUT_DIR, outputFileName(source));
  writeJson(outputFile, output);

  return {
    source,
    outputFile,
    entries: entries.length,
    ocrCells,
    lowConfidenceCells,
  };
}

export async function scrapeClassSchedules(): Promise<void> {
  console.log("Prikupljam linkove sa stranica rasporeda...");
  const sources = await discoverSources(INDEX_PAGES);
  console.log(`Pronadjeno PDF rasporeda: ${sources.length}\n`);

  const lexicon = new Set<string>();
  const results: ScrapedSchedule[] = [];
  const failures: ClassScheduleFailure[] = [];

  let indexGroups: IndexGroupRange[] | null = null;
  if (
    sources.some((source) => isFirstYearOas(source.studyLevel, source.semester))
  ) {
    try {
      indexGroups = await fetchIndexGroups();
      console.log(`Mapiranja indeksa na grupe: ${indexGroups.length}\n`);
    } catch (error) {
      console.warn(
        `  UPOZORENJE: mapiranje indeksa na grupe nije procitano: ${
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
      console.error(`GRESKA ${label}: ${message}`);
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
    `\nUspesno: ${results.length}/${sources.length} rasporeda, ukupno termina: ${totalEntries}`,
  );
  console.log(`Izlaz: ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    console.error(`Neuspesno obradjeno: ${failures.length}`);
  }
}

if (require.main === module) {
  runCli(async () => {
    try {
      await scrapeClassSchedules();
    } finally {
      await terminateOcr();
    }
  }, "Greska prilikom scrape-ovanja rasporeda casova:");
}
