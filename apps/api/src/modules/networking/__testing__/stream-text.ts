import type { Readable } from "node:stream";

/** A streamed export body (CSV, 4.9) read to the end as UTF-8 text. */
export async function streamText(body: unknown): Promise<string> {
  if (typeof body === "string") return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
