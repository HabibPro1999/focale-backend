import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { StoredSponsorshipCancellationUndoSchema, type StoredSponsorshipCancellationUndo } from "@app/contracts";
import type { DbExecutor } from "../../client";
import { sponsorshipCancellationUndo, sponsorshipUsages } from "../../schema/sponsorships";
import { readSponsorshipTarget, type SponsorshipUnlinkResult } from "../../settlement/sponsorship-link";

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function sponsorshipCoverageFingerprint(s: { coversBasePrice: boolean; coveredAccessIds: string[] | null; totalAmount: number }) {
  return hash([s.coversBasePrice, [...(s.coveredAccessIds ?? [])].sort(), s.totalAmount]);
}
export async function sponsorshipRegistrationFingerprint(tx: DbExecutor, id: string) {
  const target = await readSponsorshipTarget(tx, id);
  if (!target) return null;
  const usages = await tx.select({ sponsorshipId: sponsorshipUsages.sponsorshipId, amountApplied: sponsorshipUsages.amountApplied })
    .from(sponsorshipUsages).where(eq(sponsorshipUsages.registrationId, id)).orderBy(asc(sponsorshipUsages.sponsorshipId));
  return hash([target, usages]);
}
export async function saveSponsorshipCancellationUndo(tx: DbExecutor, sponsorship: { id: string; coversBasePrice: boolean; coveredAccessIds: string[] | null; totalAmount: number }, unlinked: SponsorshipUnlinkResult[]) {
  const links: StoredSponsorshipCancellationUndo["links"] = [];
  for (const link of unlinked) {
    const afterFingerprint = await sponsorshipRegistrationFingerprint(tx, link.registrationId);
    if (!afterFingerprint) throw new Error("Registration disappeared during cancellation");
    links.push({ registrationId: link.registrationId, afterFingerprint,
      clearedPaymentMethod: link.clearedPaymentMethod, clearedSponsorshipCode: link.clearedSponsorshipCode,
      amountApplied: link.usage.amountApplied });
  }
  const snapshot: StoredSponsorshipCancellationUndo = { version: 1, coverageFingerprint: sponsorshipCoverageFingerprint(sponsorship), links };
  await tx.insert(sponsorshipCancellationUndo).values({ sponsorshipId: sponsorship.id, snapshot })
    .onConflictDoUpdate({ target: sponsorshipCancellationUndo.sponsorshipId, set: { snapshot } });
}
export async function getSponsorshipCancellationUndo(tx: DbExecutor, id: string) {
  const [row] = await tx.select().from(sponsorshipCancellationUndo).where(eq(sponsorshipCancellationUndo.sponsorshipId, id));
  return row ? StoredSponsorshipCancellationUndoSchema.parse(row.snapshot) : null;
}
export async function clearSponsorshipCancellationUndo(tx: DbExecutor, id: string) {
  await tx.delete(sponsorshipCancellationUndo).where(eq(sponsorshipCancellationUndo.sponsorshipId, id));
}
