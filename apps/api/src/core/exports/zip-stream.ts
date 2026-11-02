import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { crc32 } from "node:zlib";
import { logger } from "../logger.service";
import { raceAbort, writeChunk } from "./stream-io";

// =============================================================================
// ZIP DOWNLOADS FROM TEMP FILES
// A multi-file export writes each file to a private temp directory with the
// streaming writers, then streams a ZIP of them into the response. Nothing is
// held in memory beyond a read buffer, and the directory is removed whatever
// happens (success, failure, client gone, shutdown).
// =============================================================================

/** Prefix of every export temp directory under os.tmpdir(). */
export const EXPORT_TEMP_DIR_PREFIX = "focale-export-";

/** Read buffer when copying a temp file into the ZIP. */
const COPY_CHUNK_BYTES = 64 * 1024;

/**
 * Runs `run` with a fresh private temp directory, removed once `run` has
 * settled. Every step of an export honors its signal, so an aborted export
 * reaches this `finally` promptly.
 */
export async function withExportTempDir<T>(
  signal: AbortSignal,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), EXPORT_TEMP_DIR_PREFIX));
  try {
    signal.throwIfAborted();
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) => {
      logger.warn({ err, dir }, "Could not remove an export temp directory");
    });
  }
}

/**
 * Writes one file at `path` with a streaming generator (the same `write` a
 * download uses) and resolves once the file is complete and closed. `write`
 * gets its own signal derived from `signal`, so the listeners of one file
 * never pile up on the export's signal. An abort settles this at once, even
 * if the generator never does.
 */
export async function writeExportFile(
  path: string,
  signal: AbortSignal,
  write: (out: Writable, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const fileSignal = AbortSignal.any([signal]);
  const file = createWriteStream(path, { flags: "wx" });
  // Always listened to: an unhandled stream 'error' would crash the process.
  const failed = new Promise<never>((_, reject) => file.on("error", reject));
  const closed = new Promise<void>((resolve) => file.once("close", resolve));
  try {
    await raceAbort(Promise.race([write(file, fileSignal), failed]), signal);
    // The generator ended the file; read it back only once it is closed.
    await raceAbort(Promise.race([closed, failed]), signal);
  } finally {
    if (!file.closed) file.destroy();
  }
}

export interface ZipFileEntry {
  /** Name inside the ZIP. */
  name: string;
  /** Complete file on disk. */
  path: string;
}

/** Past this, a size or offset needs ZIP64, which this writer does not do. */
const ZIP32_LIMIT = 0xffffffff;
const ZIP_MAX_ENTRIES = 0xffff;
/** General purpose flag bit 11: names are UTF-8. */
const ZIP_UTF8_FLAG = 0x0800;
/** Version 2.0: the lowest, enough for stored entries. */
const ZIP_VERSION = 20;

/** MS-DOS date and time fields (UTC, 2-second resolution). */
function dosDateTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date:
      ((Math.max(at.getUTCFullYear(), 1980) - 1980) << 9) |
      ((at.getUTCMonth() + 1) << 5) |
      at.getUTCDate(),
  };
}

/** Size and CRC-32 of a file, read in chunks. */
async function fileChecksum(
  path: string,
  signal: AbortSignal,
): Promise<{ size: number; crc: number }> {
  let size = 0;
  let crc = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: COPY_CHUNK_BYTES })) {
    signal.throwIfAborted();
    const bytes = chunk as Buffer;
    size += bytes.length;
    crc = crc32(bytes, crc);
  }
  return { size, crc };
}

/**
 * Streams a ZIP of `entries` into `out` and ends it. Entries are stored, not
 * deflated (XLSX files are zips already; the in-memory JSZip archive stored
 * them too), each preceded by a local header carrying its CRC-32 and size, so
 * any reader can unpack it without a data descriptor. Writes honor `out`'s
 * backpressure and stop when `signal` aborts.
 */
export async function writeStoredZip(
  out: Writable,
  entries: readonly ZipFileEntry[],
  signal: AbortSignal,
  now: Date = new Date(),
): Promise<void> {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error("Too many ZIP entries");
  const { time, date } = dosDateTime(now);
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    signal.throwIfAborted();
    const name = Buffer.from(entry.name, "utf8");
    const { size, crc } = await fileChecksum(entry.path, signal);
    if (size >= ZIP32_LIMIT || offset + 30 + name.length + size >= ZIP32_LIMIT) {
      throw new Error("ZIP export exceeds 4 GB");
    }

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    await writeChunk(out, local, signal);

    let copied = 0;
    for await (const chunk of createReadStream(entry.path, { highWaterMark: COPY_CHUNK_BYTES })) {
      const bytes = chunk as Buffer;
      copied += bytes.length;
      await writeChunk(out, bytes, signal);
    }
    if (copied !== size) throw new Error(`ZIP entry ${entry.name} changed while being written`);

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(ZIP_VERSION, 4); // made by (MS-DOS)
    header.writeUInt16LE(ZIP_VERSION, 6); // needed
    header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    header.writeUInt16LE(0, 10); // stored
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    // extra length, comment length, disk number, internal and external
    // attributes: all zero.
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);
    central.push(header);

    offset += local.length + size;
  }

  const directory = Buffer.concat(central);
  if (offset + directory.length >= ZIP32_LIMIT) throw new Error("ZIP export exceeds 4 GB");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeChunk(out, Buffer.concat([directory, end]), signal);
  out.end();
}
