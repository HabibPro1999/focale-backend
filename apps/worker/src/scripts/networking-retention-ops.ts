import { parseArgs } from "node:util";
import {
  countOrphanNetworkingEmailLogs,
  eraseNetworkingProfile,
  networkingProfilePhotoRefs,
  networkingProfilesToErase,
  networkingPurgeCandidates,
  purgeNetworkingEvent,
  purgeOrphanNetworkingEmailLogs,
} from "@app/db";
import {
  STORAGE_LIST_MAX_LIMIT,
  isStorageObjectMissing,
  ownedStorageKey,
  type StorageProvider,
} from "@app/integrations";

// Networking retention runbook (plan 4.4; operator steps in NETWORKING.md).
// Every command is a dry run unless --apply is given, and --apply is refused
// without --backup-verified=<reference> naming the verified backup taken first.

export const NETWORKING_RETENTION_COMMANDS = ["purge-leftovers", "erase-withdrawn", "orphan-photos"] as const;
export type NetworkingRetentionCommand = (typeof NETWORKING_RETENTION_COMMANDS)[number];

export interface NetworkingRetentionOptions {
  command: NetworkingRetentionCommand;
  apply: boolean;
  /** The verified backup (database snapshot, or bucket copy for orphan-photos) --apply relies on. */
  backupVerified?: string;
  eventId?: string;
  /** Rows per statement (database commands) or keys per listing page (orphan-photos). */
  batchSize: number;
  /** erase-withdrawn: profiles per run. */
  limit: number;
  /** orphan-photos: objects younger than this are never touched (an upload may not be saved yet). */
  minAgeHours: number;
}

export const NETWORKING_RETENTION_USAGE = [
  "Usage: networking-retention <purge-leftovers | erase-withdrawn | orphan-photos>",
  "         [--event <id>] [--batch-size <n>] [--limit <n>] [--min-age-hours <n>]",
  "         [--apply --backup-verified=<backup reference>]",
  "  (image: node apps/worker/dist/scripts/networking-retention.js ...)",
  "",
  "Dry run by default. --apply needs --backup-verified naming the backup you took and verified first.",
  "--batch-size 1-1000 (default 500; orphan-photos: keys per listing page, default 1000).",
  "--limit 1-1000 withdrawn profiles per run (erase-withdrawn, default 100).",
  "--min-age-hours >= 1 (orphan-photos, default 24).",
].join("\n");

function integer(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function parseNetworkingRetentionArgs(argv: string[]): NetworkingRetentionOptions {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: "boolean" },
      "backup-verified": { type: "string" },
      event: { type: "string" },
      "batch-size": { type: "string" },
      limit: { type: "string" },
      "min-age-hours": { type: "string" },
    },
  });
  const [command, ...extra] = positionals;
  if (!NETWORKING_RETENTION_COMMANDS.includes(command as NetworkingRetentionCommand) || extra.length)
    throw new Error(NETWORKING_RETENTION_USAGE);
  const backupVerified = values["backup-verified"]?.trim() || undefined;
  if (values.apply && !backupVerified)
    throw new Error("--apply needs --backup-verified=<backup reference>: take and verify a backup first (NETWORKING.md)");
  const photos = command === "orphan-photos";
  return {
    command: command as NetworkingRetentionCommand,
    apply: values.apply === true,
    backupVerified,
    eventId: values.event?.trim() || undefined,
    batchSize: integer(values["batch-size"], "batch-size", photos ? STORAGE_LIST_MAX_LIMIT : 500, 1, 1000),
    limit: integer(values.limit, "limit", 100, 1, 1000),
    minAgeHours: integer(values["min-age-hours"], "min-age-hours", 24, 1, 24 * 365),
  };
}

type Print = (line: string) => void;
const iso = (value: Date | null) => value?.toISOString() ?? "-";
function preamble(options: NetworkingRetentionOptions, print: Print) {
  print(options.apply
    ? `APPLY ${options.command} (backup: ${options.backupVerified})${options.eventId ? ` event=${options.eventId}` : ""}`
    : `Dry run ${options.command}${options.eventId ? ` event=${options.eventId}` : ""}: nothing is changed.`);
}
const rerun = (print: Print) => print("Re-run with --apply --backup-verified=<backup reference> to apply.");

/**
 * Events past retention that still hold networking data (never purged,
 * interrupted, or refilled), then networking email logs of deleted events.
 * The worker's maintenance purges expired events on its own; this is the
 * supervised path, without a time budget.
 */
export async function runPurgeLeftovers(options: NetworkingRetentionOptions, print: Print) {
  preamble(options, print);
  const candidates = await networkingPurgeCandidates(options.eventId);
  for (const event of candidates)
    print(`event=${event.eventId} ended=${iso(event.endDate)} retentionDays=${event.retentionDays} purgeStarted=${iso(event.purgeStartedAt)} purged=${iso(event.purgedAt)} profiles=${event.profiles}`);
  // Orphaned logs have no event to scope by.
  const orphanLogs = options.eventId ? 0 : await countOrphanNetworkingEmailLogs();
  print(`${candidates.length} event(s) past retention to purge; ${orphanLogs} networking email log(s) of deleted events.`);
  if (!options.apply) {
    if (candidates.length || orphanLogs) rerun(print);
    return { events: candidates.length, orphanLogs, deleted: 0 };
  }
  let deleted = 0;
  for (const event of candidates) {
    const result = await purgeNetworkingEvent(event.eventId, {
      batchSize: options.batchSize,
      onBatch: (table, count) => {
        if (count) print(`batch event=${event.eventId} table=${table} deleted=${count}`);
      },
    });
    const total = Object.values(result.deleted).reduce((sum, count) => sum + count, 0);
    deleted += total;
    print(`purged event=${event.eventId} rows=${total}`);
  }
  if (orphanLogs)
    deleted += await purgeOrphanNetworkingEmailLogs({
      batchSize: options.batchSize,
      onBatch: (count) => {
        if (count) print(`batch table=email_logs (deleted events) deleted=${count}`);
      },
    });
  print(`Done: ${deleted} row(s) deleted.`);
  return { events: candidates.length, orphanLogs, deleted };
}

/** Withdrawn profiles past NETWORKING_WITHDRAWAL_ERASE_DAYS, erased to tombstones one by one. */
export async function runEraseWithdrawn(options: NetworkingRetentionOptions, eraseDays: number, print: Print) {
  preamble(options, print);
  const due = await networkingProfilesToErase({ eraseDays, eventId: options.eventId, limit: options.limit });
  for (const profile of due)
    print(`profile=${profile.profileId} event=${profile.eventId} withdrawnAt=${iso(profile.withdrawnAt)}`);
  print(`${due.length} withdrawn profile(s) past the ${eraseDays}-day window${due.length === options.limit ? ` (first ${options.limit}; run again for more)` : ""}.`);
  if (!options.apply) {
    if (due.length) rerun(print);
    return { due: due.length, erased: 0 };
  }
  let erased = 0;
  for (const { profileId } of due) {
    const result = await eraseNetworkingProfile(profileId, {
      batchSize: options.batchSize,
      onBatch: (table, count) => {
        if (count) print(`batch profile=${profileId} table=${table} ${table === "networking_profiles" ? "scrubbed" : "deleted"}=${count}`);
      },
    });
    if (result.erased) erased++;
  }
  print(`Done: ${erased} profile(s) erased.`);
  return { due: due.length, erased };
}

const PHOTO_KEY = /^networking\/([^/]+)\/profiles\/([^/]+)\/[^/]+$/;

/**
 * Profile photos in storage that no profile references any more (a replaced
 * photo whose best-effort delete failed, or objects left by older code). Only
 * keys under networking/<event>/profiles/<profile>/ are considered; branding
 * and reports are never touched, nor objects younger than --min-age-hours.
 */
export async function runOrphanPhotos(
  options: NetworkingRetentionOptions,
  storage: StorageProvider,
  print: Print,
  now = Date.now(),
) {
  preamble(options, print);
  const prefix = options.eventId ? `networking/${options.eventId}/profiles/` : "networking/";
  const cutoff = now - options.minAgeHours * 3_600_000;
  const totals = { listed: 0, orphans: 0, deleted: 0, missing: 0 };
  let cursor: string | undefined;
  let page = 0;
  do {
    const listing = await storage.list(prefix, { cursor, limit: options.batchSize });
    page++;
    const photos = listing.items.flatMap((item) => {
      const match = PHOTO_KEY.exec(item.key);
      // Unknown age counts as too young: never delete what might be an unsaved upload.
      if (!match || !item.updatedAt || item.updatedAt.getTime() > cutoff) return [];
      return [{ ...item, eventId: match[1]!, profileId: match[2]! }];
    });
    const refs = new Map((await networkingProfilePhotoRefs([...new Set(photos.map((photo) => photo.profileId))]))
      .map((ref) => [ref.id, ref]));
    let orphans = 0, deleted = 0;
    for (const photo of photos) {
      const owner = `networking/${photo.eventId}/profiles/${photo.profileId}`;
      const ref = refs.get(photo.profileId);
      const referenced = !!ref && ref.eventId === photo.eventId &&
        [ref.photoUrl, ref.overridePhotoUrl].some((url) => ownedStorageKey(url, owner) === photo.key);
      if (referenced) continue;
      orphans++;
      print(`orphan key=${photo.key} reason=${ref ? "not-referenced" : "profile-missing"} updatedAt=${iso(photo.updatedAt)}`);
      if (!options.apply) continue;
      // The same guard as the storage.delete handler: only a key strictly under the owner's prefix.
      if (ownedStorageKey(photo.key, owner) !== photo.key) continue;
      try {
        await storage.delete(photo.key);
        deleted++;
      } catch (error) {
        if (!isStorageObjectMissing(error)) throw error;
        totals.missing++;
      }
    }
    totals.listed += listing.items.length;
    totals.orphans += orphans;
    totals.deleted += deleted;
    print(`page=${page} listed=${listing.items.length} photos=${photos.length} orphans=${orphans}${options.apply ? ` deleted=${deleted}` : ""}`);
    cursor = listing.nextCursor ?? undefined;
  } while (cursor);
  print(`${totals.listed} object(s) listed under ${prefix}; ${totals.orphans} orphaned profile photo(s)${options.apply ? `; ${totals.deleted} deleted, ${totals.missing} already gone` : ""}.`);
  if (!options.apply && totals.orphans) rerun(print);
  return totals;
}
