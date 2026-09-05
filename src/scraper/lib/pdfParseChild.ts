import { PDFParse } from "pdf-parse";

/**
 * Ovaj fajl se pokrece SAMO u odvojenom Node procesu, nikad require-ovan iz
 * glavnog procesa. "pdf-parse" nosi svoju verziju @napi-rs/canvas i pdfjs-dist,
 * odvojenu od one koju koristi scrapeClassSchedules (preko pdfPageLoader.ts).
 * Kad se obe ucitaju u isti proces, dva razlicita native (Rust) modula se
 * sudaraju i daju netacne greske ("Value is none of these types") ili
 * ("API version does not match Worker version"). Odvojen proces resava to bez
 * dodirivanja verzija paketa.
 *
 * PDF stize kao sirovi bajtovi na stdin; rezultat se ispisuje kao JSON na
 * stdout. Nista drugo ne sme da pise na stdout.
 */

function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const pdf = await readStdin();
  const parser = new PDFParse({ data: pdf });
  const result = await parser.getText();
  process.stdout.write(JSON.stringify({ text: result.text }));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
