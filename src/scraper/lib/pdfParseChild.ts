import { PDFParse } from "pdf-parse";

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
