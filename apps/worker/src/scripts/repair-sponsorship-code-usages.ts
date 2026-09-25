/* eslint no-console: "off" */
import { parseArgs } from "node:util";
import {
  applySponsorshipCodeLink,
  closeDb,
  configureDb,
  planSponsorshipCodeRepair,
  type SponsorshipCodeDecision,
  type SponsorshipCodeLink,
} from "@app/db";

// Repair signup sponsorship codes stored before codes were consumed (plan
// 2.7). Dry run by default: prints the links it would make (codes with a
// single claimant, linked like a signup through settleRegistrationTxn) and a
// business-decision list (several claimants, unknown or cancelled codes,
// amounts without a code, refunded or settled claimants whose money would
// change). --json prints the plan as JSON.
//
// --apply links the selected rows (--all, or --registration <id>...), each in
// its own locking transaction after re-planning its code under the locks;
// a row that changed since the plan is skipped. Do not apply before plan 2.8
// is deployed: until then the sponsorship batch-link path writes absolute
// amounts without these locks and can overwrite a repaired row. Links that
// would fill an access item are skipped until 2.8 adds the capacity drop.
// Reads DATABASE_URL from the environment.

const CONFIRM_FLAG = "confirm-2-8-deployed";

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @app/worker repair-sponsorship-code-usages [--event <id>] [--json]",
    `  pnpm --filter @app/worker repair-sponsorship-code-usages --apply --${CONFIRM_FLAG} (--all | --registration <id>...) [--event <id>]`,
    "  (image: node apps/worker/dist/scripts/repair-sponsorship-code-usages.js ...)",
    "",
    "Dry run by default. --apply needs plan 2.8 deployed (acknowledged by the flag above)",
    "and an explicit selection: --all planned links, or the listed registrations only.",
  ].join("\n");
}

function describeLink(link: SponsorshipCodeLink): string {
  const places = Object.entries(link.paidPlaces).map(([id, delta]) => `${id}:${delta > 0 ? "+" : ""}${delta}`);
  return [
    "link",
    `registration=${link.registrationId}`,
    `ref=${link.referenceNumber ?? "-"}`,
    `event=${link.eventId}`,
    `code=${link.code}`,
    `status=${link.before.paymentStatus}->${link.after.paymentStatus}`,
    `sponsorship=${link.before.sponsorshipAmount}->${link.after.sponsorshipAmount}`,
    `due=${link.after.amountDue}`,
    `paidPlaces=${places.length > 0 ? places.join(",") : "-"}`,
    ...(link.fillsCapacity.length > 0 ? [`fillsCapacity=${link.fillsCapacity.join(",")}`] : []),
  ].join(" ");
}

function describeDecision(decision: SponsorshipCodeDecision): string {
  return [
    "decide",
    `reason=${decision.reason}`,
    `event=${decision.eventId}`,
    `code=${decision.code ?? "-"}`,
    `sponsorship=${decision.sponsorshipId ?? "-"}`,
    `registrations=${decision.registrationIds.join(",")}`,
    `detail=${JSON.stringify(decision.detail)}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      apply: { type: "boolean" },
      [CONFIRM_FLAG]: { type: "boolean" },
      all: { type: "boolean" },
      registration: { type: "string", multiple: true },
      event: { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  const apply = values.apply === true;
  const selected = new Set(values.registration ?? []);
  if (apply) {
    if (values[CONFIRM_FLAG] !== true) {
      throw new Error(`--apply needs --${CONFIRM_FLAG}: apply only once plan 2.8 is deployed`);
    }
    if ((values.all === true) === selected.size > 0) {
      throw new Error("--apply needs exactly one of --all or --registration <id>...");
    }
  } else if (values.all || selected.size > 0) {
    throw new Error("--all and --registration only apply with --apply");
  }

  configureDb({ applicationName: "focale-repair-sponsorship-code-usages" });
  try {
    const plan = await planSponsorshipCodeRepair({ eventId: values.event });
    if (!apply && values.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(
      `${apply ? "Apply" : "Dry run"}: ${plan.links.length} link(s), ${plan.decisions.length} decision(s), ` +
        `${plan.alreadyLinked} code(s) already linked.`,
    );
    for (const decision of plan.decisions) console.log(describeDecision(decision));
    const links = apply && selected.size > 0 ? plan.links.filter((l) => selected.has(l.registrationId)) : plan.links;
    for (const link of links) console.log(describeLink(link));
    if (!apply) {
      if (plan.links.length > 0) console.log("No rows changed. Review, then re-run with --apply after plan 2.8 is deployed.");
      return;
    }
    const missing = [...selected].filter((id) => !links.some((link) => link.registrationId === id));
    for (const id of missing) console.log(`not-planned registration=${id} (no single-claimant link for it now)`);

    let linked = 0;
    for (const link of links) {
      const result = await applySponsorshipCodeLink(link);
      if (result.outcome === "linked") {
        linked += 1;
        console.log(`linked registration=${result.registrationId} status=${result.paymentStatus} sponsorship=${result.sponsorshipAmount}`);
      } else {
        console.log(`skipped registration=${result.registrationId} reason=${result.reason} detail=${JSON.stringify(result.detail)}`);
      }
    }
    console.log(`Linked ${linked} of ${links.length} planned link(s).`);
  } finally {
    await closeDb();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage());
    process.exit(1);
  });
