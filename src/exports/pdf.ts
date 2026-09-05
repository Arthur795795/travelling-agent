import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Trip } from "../domain/schema.ts";
import {
  projectTrip,
  DisclosureSchema,
  type Disclosure,
} from "../trips/presentation.ts";
export async function exportPdf(
  trip: Trip,
  fields: Partial<Disclosure> = {},
): Promise<Buffer> {
  const payload = {
    trip: projectTrip(trip, fields),
    fields: DisclosureSchema.parse(fields),
  };
  const font = process.env.PDF_FONT_PATH;
  if (!font) throw new Error("PDF_FONT_UNAVAILABLE");
  return new Promise((accept, reject) => {
    const processHandle = spawn(/* turbopackIgnore: true */
      process.env.PDF_PYTHON ?? "python3",
      [join(process.cwd(), "scripts", "render-trip-pdf.py"), font],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processHandle.kill();
      reject(new Error("PDF_RENDER_FAILED"));
    };
    const timer = setTimeout(fail, 30000);
    processHandle.on("error", fail);
    processHandle.stdin.on("error", fail);
    processHandle.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 15 * 1024 * 1024) fail();
      else chunks.push(chunk);
    });
    processHandle.stderr.resume(); // Never forward payload-dependent renderer errors.
    processHandle.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timer);
      const pdf = Buffer.concat(chunks);
      if (pdf.subarray(0, 5).toString() !== "%PDF-")
        reject(new Error("PDF_RENDER_FAILED"));
      else accept(pdf);
    });
    processHandle.stdin.end(JSON.stringify(payload));
  });
}
