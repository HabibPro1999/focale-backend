import JSZip from "jszip";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { useIsolatedTmpdir } from "./__testing__/export-output";
import { ExportAbortedError, writeChunk } from "./stream-io";
import { withExportTempDir, writeExportFile, writeStoredZip } from "./zip-stream";

const exportTempDirs = useIsolatedTmpdir();

/** Collects everything written: one write per event-loop turn, small buffer. */
function sink(highWaterMark = 16 * 1024) {
  const chunks: Buffer[] = [];
  let maxBuffered = 0;
  const out = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      maxBuffered = Math.max(maxBuffered, out.writableLength);
      setImmediate(callback);
    },
  });
  const finished = new Promise((resolve) => out.on("finish", resolve));
  return {
    out,
    finished,
    bytes: () => Buffer.concat(chunks),
    maxBuffered: () => maxBuffered,
  };
}

const quiet = () => new AbortController().signal;

describe("writeStoredZip", () => {
  it("streams a stored ZIP any reader can unpack (UTF-8 names, CRC-32, sizes up front)", async () => {
    await withExportTempDir(quiet(), async (dir) => {
      const files = [
        { name: "congres-global-checkin.xlsx", bytes: randomBytes(200_000) },
        { name: "déjeuner-checkin.xlsx", bytes: Buffer.from("déjeuner") },
        { name: "ورشة-checkin.xlsx", bytes: Buffer.alloc(0) },
      ];
      const entries = files.map((file, i) => {
        const path = join(dir, `${i}.bin`);
        writeFileSync(path, file.bytes);
        return { name: file.name, path };
      });
      const { out, finished, bytes } = sink();

      await writeStoredZip(out, entries, quiet(), new Date("2026-03-02T10:15:30Z"));
      await finished;

      const zipBytes = bytes();
      const zip = await JSZip.loadAsync(zipBytes, { checkCRC32: true });
      expect(Object.keys(zip.files)).toEqual(files.map((file) => file.name));
      for (const file of files) {
        expect((await zip.file(file.name)!.async("nodebuffer")).equals(file.bytes)).toBe(true);
      }

      // First local header: stored (method 0), UTF-8 flag, CRC and both sizes
      // filled in (no data descriptor), DOS time 10:15:30 on 2026-03-02.
      expect(zipBytes.readUInt32LE(0)).toBe(0x04034b50);
      expect(zipBytes.readUInt16LE(6)).toBe(0x0800);
      expect(zipBytes.readUInt16LE(8)).toBe(0);
      expect(zipBytes.readUInt16LE(10)).toBe((10 << 11) | (15 << 5) | 15);
      expect(zipBytes.readUInt16LE(12)).toBe(((2026 - 1980) << 9) | (3 << 5) | 2);
      expect(zipBytes.readUInt32LE(14)).toBe(crc32(files[0]!.bytes));
      expect(zipBytes.readUInt32LE(18)).toBe(200_000);
      expect(zipBytes.readUInt32LE(22)).toBe(200_000);
      // End of central directory: three entries.
      const end = zipBytes.subarray(zipBytes.length - 22);
      expect(end.readUInt32LE(0)).toBe(0x06054b50);
      expect(end.readUInt16LE(10)).toBe(3);
    });
  });

  it("writes a valid empty ZIP for no entries", async () => {
    const { out, finished, bytes } = sink();
    await writeStoredZip(out, [], quiet());
    await finished;

    expect(bytes()).toHaveLength(22);
    expect(Object.keys((await JSZip.loadAsync(bytes())).files)).toEqual([]);
  });

  it("honors the output's backpressure (never more than one read chunk past its buffer)", async () => {
    await withExportTempDir(quiet(), async (dir) => {
      const path = join(dir, "big.bin");
      writeFileSync(path, randomBytes(2 * 1024 * 1024));
      const { out, finished, bytes, maxBuffered } = sink(16 * 1024);

      await writeStoredZip(out, [{ name: "big.bin", path }], quiet());
      await finished;

      expect(maxBuffered()).toBeLessThanOrEqual(16 * 1024 + 64 * 1024);
      expect(bytes().length).toBeGreaterThan(2 * 1024 * 1024);
    });
  });

  it("stops with the abort reason and leaves the output unended", async () => {
    await withExportTempDir(quiet(), async (dir) => {
      const path = join(dir, "big.bin");
      writeFileSync(path, randomBytes(1024 * 1024));
      const controller = new AbortController();
      const out = new PassThrough({ highWaterMark: 1024 });
      out.once("data", () => controller.abort(new ExportAbortedError("client-closed")));
      out.resume();

      await expect(
        writeStoredZip(out, [{ name: "big.bin", path }], controller.signal),
      ).rejects.toMatchObject({ reason: "client-closed" });
      expect(out.writableEnded).toBe(false);
    });
  });
});

describe("withExportTempDir", () => {
  it("gives a private directory, removed after success", async () => {
    let seen = "";
    const result = await withExportTempDir(quiet(), async (dir) => {
      seen = dir;
      writeFileSync(join(dir, "a.xlsx"), "x");
      expect(exportTempDirs()).toHaveLength(1);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(existsSync(seen)).toBe(false);
    expect(exportTempDirs()).toEqual([]);
  });

  it("removes the directory when the run fails", async () => {
    await expect(
      withExportTempDir(quiet(), async (dir) => {
        writeFileSync(join(dir, "a.xlsx"), "x");
        throw new Error("generation failed");
      }),
    ).rejects.toThrow("generation failed");

    expect(exportTempDirs()).toEqual([]);
  });

  it("creates nothing when the export is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new ExportAbortedError("shutdown"));

    await expect(withExportTempDir(controller.signal, async () => "never")).rejects.toMatchObject({
      reason: "shutdown",
    });
    expect(exportTempDirs()).toEqual([]);
  });
});

describe("writeExportFile", () => {
  it("resolves once the generated file is complete on disk", async () => {
    await withExportTempDir(quiet(), async (dir) => {
      const path = join(dir, "0.xlsx");
      await writeExportFile(path, quiet(), async (file, signal) => {
        for (let i = 0; i < 100; i++) await writeChunk(file, `row ${i}\n`, signal);
        file.end();
      });

      expect(readFileSync(path, "utf8").split("\n")).toHaveLength(101);
    });
  });

  it("refuses to overwrite an existing file", async () => {
    await withExportTempDir(quiet(), async (dir) => {
      const path = join(dir, "0.xlsx");
      writeFileSync(path, "already here");

      await expect(
        writeExportFile(path, quiet(), async (file) => {
          file.end("new");
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(path, "utf8")).toBe("already here");
    });
  });

  it("settles on abort even when the generator never does, and aborts the generator", async () => {
    await withExportTempDir(quiet(), async (dir) => {
      const controller = new AbortController();
      let fileSignal: AbortSignal | undefined;
      const writing = writeExportFile(join(dir, "0.xlsx"), controller.signal, async (_file, signal) => {
        fileSignal = signal;
        await new Promise(() => undefined);
      });
      await tick();

      controller.abort(new ExportAbortedError("client-closed"));

      await expect(writing).rejects.toMatchObject({ reason: "client-closed" });
      expect(fileSignal?.aborted).toBe(true);
    });
    expect(exportTempDirs()).toEqual([]);
  });
});
