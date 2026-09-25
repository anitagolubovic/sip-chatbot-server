import { spawn } from "child_process";
import path from "path";

const CHILD_SCRIPT = path.join(__dirname, "pdfParseChild.ts");
const REGISTER_HOOK = require.resolve("ts-node/register/transpile-only");

export function extractPdfText(pdf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-r", REGISTER_HOOK, CHILD_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            `pdf-parse child process exited with code ${code}: ${message || "no error output"}`,
          ),
        );
        return;
      }

      try {
        const { text } = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
          text: string;
        };
        resolve(text);
      } catch (error) {
        reject(
          new Error(
            `Could not parse pdf-parse child process output: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });

    child.stdin.end(pdf);
  });
}
