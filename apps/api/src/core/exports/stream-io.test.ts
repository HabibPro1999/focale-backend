import type { Readable, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ExportAbortedError, downloadBody, raceAbort, writeChunk } from "./stream-io";

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("raceAbort", () => {
  it("settles like the work when the signal stays quiet", async () => {
    const signal = new AbortController().signal;
    await expect(raceAbort(Promise.resolve(42), signal)).resolves.toBe(42);
    await expect(raceAbort(Promise.reject(new Error("boom")), signal)).rejects.toThrow("boom");
  });

  it("rejects with the abort reason as soon as the signal aborts, even if the work never settles", async () => {
    const controller = new AbortController();
    const raced = raceAbort(new Promise(() => undefined), controller.signal);
    const reason = new ExportAbortedError("client-closed");

    controller.abort(reason);

    await expect(raced).rejects.toBe(reason);
  });

  it("rejects at once on an already-aborted signal, leaving the work's failure handled", async () => {
    const controller = new AbortController();
    controller.abort(new ExportAbortedError("shutdown"));
    let failWork!: (err: Error) => void;
    const work = new Promise((_, reject) => (failWork = reject));

    await expect(raceAbort(work, controller.signal)).rejects.toMatchObject({ reason: "shutdown" });
    failWork(new Error("late failure")); // must not surface as an unhandled rejection
    await tick();
  });
});

describe("downloadBody", () => {
  it("streams the generated file as the body is read", async () => {
    const body = downloadBody({
      filename: "f.txt",
      contentType: "text/plain",
      write: async (out: Writable, signal: AbortSignal) => {
        for (let i = 0; i < 3; i++) await writeChunk(out, `line ${i}\n`, signal);
        out.end();
      },
    });

    expect((await readAll(body)).toString()).toBe("line 0\nline 1\nline 2\n");
  });

  it("destroys the body when generation fails, so the client sees a broken download", async () => {
    const body = downloadBody({
      filename: "f.txt",
      contentType: "text/plain",
      write: async (out: Writable, signal: AbortSignal) => {
        await writeChunk(out, "partial", signal);
        throw new Error("page read failed");
      },
    });

    await expect(readAll(body)).rejects.toThrow("page read failed");
  });

  it("aborts generation when the body is destroyed (client gone)", async () => {
    let seen: AbortSignal | undefined;
    const body = downloadBody({
      filename: "f.txt",
      contentType: "text/plain",
      write: async (out: Writable, signal: AbortSignal) => {
        seen = signal;
        // Endless, paced by the reader: only the abort stops it.
        for (;;) await writeChunk(out, Buffer.alloc(64 * 1024), signal);
      },
    });
    body.once("data", () => body.destroy());
    body.resume();

    await new Promise((resolve) => body.once("close", resolve));
    await tick();

    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toMatchObject({ reason: "client-closed" });
  });
});
