/* eslint no-console: "off" */
import { parseArgs } from "node:util";
import {
  applySponsorshipCodeLink,
  clearRegistrationSponsorshipCode,
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
// a row that changed since the plan is skipped. A link that fills an access
// item enqueues its capacity drop (plan 2.8).
//
// --clear-code --registration <id>... resolves decision-list rows one by one
// (an unknown code, the losing claimants of a shared code): it clears the
// stored code and, without a linked usage, the signup amount priced from it.
// It prints what it would do unless --apply is given, and never picks rows
// itself. Reads DATABASE_URL from the environment.

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @app/worker repair-sponsorship-code-usages [--event <id>] [--json]",
    "  pnpm --filter @app/worker repair-sponsorship-code-usages --apply (--all | --registration <id>...) [--event <id>]",
    "  pnpm --filter @app/worker repair-sponsorship-code-usages --clear-code --registration <id>... [--apply]",
    "  (image: node apps/worker/dist/scripts/repair-sponsorship-code-usages.js ...)",
    "",
    "Dry run by default. --apply links an explicit selection: --all planned links, or the listed",
    "registrations only. --clear-code clears the stored code of the listed registrations only.",
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

async function clearCodes(registrationIds: string[], apply: boolean): Promise<void> {
  console.log(`${apply ? "Clear" : "Dry run, clear"} code: ${registrationIds.length} registration(s).`);
  let cleared = 0;
  for (const registrationId of registrationIds) {
    const result = await clearRegistrationSponsorshipCode(registrationId, { apply });
    if (result.outcome === "skipped") {
      console.log(`skipped registration=${registrationId} reason=${result.reason} detail=${JSON.stringify(result.detail)}`);
      continue;
    }
    if (result.outcome === "cleared") cleared += 1;
    console.log(
      [
        result.outcome === "cleared" ? "cleared" : "would-clear",
        `registration=${registrationId}`,
        `code=${JSON.stringify(result.code)}`,
        `status=${result.before.paymentStatus}->${result.after.paymentStatus}`,
        `sponsorship=${result.before.sponsorshipAmount}->${result.after.sponsorshipAmount}`,
        `due=${result.after.amountDue}`,
      ].join(" "),
    );
  }
  if (apply) console.log(`Cleared ${cleared} of ${registrationIds.length}.`);
  else console.log("No rows changed. Re-run with --apply to clear.");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      apply: { type: "boolean" },
      "clear-code": { type: "boolean" },
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
  if (values["clear-code"]) {
    if (values.all || values.event || values.json || selected.size === 0) {
      throw new Error("--clear-code needs --registration <id>... (no --all, --event or --json)");
    }
  } else if (apply) {
    if ((values.all === true) === selected.size > 0) {
      throw new Error("--apply needs exactly one of --all or --registration <id>...");
    }
  } else if (values.all || selected.size > 0) {
    throw new Error("--all and --registration only apply with --apply or --clear-code");
  }

  configureDb({ applicationName: "focale-repair-sponsorship-code-usages" });
  try {
    if (values["clear-code"]) {
      await clearCodes([...selected], apply);
      return;
    }
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
      if (plan.links.length > 0) console.log("No rows changed. Review, then re-run with --apply and a selection.");
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
