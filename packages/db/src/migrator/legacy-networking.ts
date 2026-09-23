import {
  type MigrationDefinition,
  migrationChecksum,
  statementChecksum,
} from "./migration";

/** Legacy `networking_migrations` file checksums from the 1.1 base commit. */
export const LEGACY_NETWORKING_FILE_CHECKSUMS = Object.freeze({
  "0012:shared": "3589e2aafcf2e7ff9a2ddeba7b4731fc2bd2e93edf6c36d079ded183c81b646b",
  "0013:shared": "f253e94d7ea490e05ddf7b229027fa6538bfef55a15f7f92195a852fb32d72f8",
  "0014:shared": "da126ec52caaca1506912d1e5c61b8e36c59faba46ad4130ee92928eaf8089ee",
  "0015:shared": "2ed4213c47353e9feaccd0181c277c4c5e44cdd4fba69d5cfc74014fe54e3565",
  "0016:shared": "f0417210f3954864180f028370666b5991d06e79c2203a4a1a7a3736aef51522",
  "0017:cockroach": "07147c323873f120fb0a378e57cf3746736ed926a8e6cae3fedf4df9f6162e81",
  "0018:shared": "005f764942e207c6a75baaea58f9555d23aad85efe792be9fdfcb0194dd09078",
  "0019:shared": "0241205b8147777126f077751ee7464a98f6f47f2d045aa1aa3321bc4d665acb",
});

/**
 * Fixed provenance for the old migrate-networking.mjs implementation. Do not
 * regenerate these values from the edited variant: they describe bytes and
 * step hashes already recorded in the legacy networking_migrations ledger.
 */
export const LEGACY_NETWORKING_0018_CROSSWALK = Object.freeze({
  id: "0018",
  legacyName: "0018_networking_spaces.sql",
  legacyFileChecksum: "005f764942e207c6a75baaea58f9555d23aad85efe792be9fdfcb0194dd09078",
  variant: "cockroach" as const,
  variantName: "0018_networking_spaces.sql",
  variantFileChecksum: "c1544aec93feb31fa0c4927a28b7b2fe8aaa6d54deb8b75595ef1895c6f891b0",
  steps: Object.freeze([
    {
      legacyChecksum: "28a769eadf75f59d990fcb326a7723083e4fd62c0c6d61cd81e5e211d8f786bd",
      variantChecksum: "b3af595506e88a8092c7bc1e28cb9d56c94458f53cc497a0e52e1d46c3d5864a",
    },
    {
      legacyChecksum: "28e2238eb2fbf5099c8751ebc92e277a3c0741e6bd866aad3ff94249d8a9c606",
      variantChecksum: "6efda7d1a2f5b9b42c4f4d3c8376d119442d6ed984f65539dc62260401a503a7",
    },
    {
      legacyChecksum: "b78fd3200f9a8071ba1489a8286f07793e6145b7f9db449fb31b9ed2406c9089",
      variantChecksum: "d0b6ad4258d86408d13a57f225b1197b2ca9994d6aff6c03f81b7683f58de4b1",
    },
    {
      legacyChecksum: "a1c6a506111a13c45000326ed01af0ba35bbb01542946c37c3f7bc6b2bfc0eec",
      variantChecksum: "4a6666e96ce8bacbcbb0fa31f7c77c1c95ee5b1675792fedbd89ede60b041027",
    },
    {
      legacyChecksum: "a4bb3173670c953f0fbc4132f18c9c35cfee1a78472d6f3aaabb06791a6596a0",
      variantChecksum: "5709043d1c39eadb3bf7c76e1d84e7e8aa06790aba1c99d34261d58d74bf770c",
    },
    {
      legacyChecksum: "cac600198f8101f6b3a0233fdf1e8308201ebaae78a8f207c55626c903793c5c",
      variantChecksum: "6de3fb41830eae3cd3612e9f7d729d39797e64287ae086254715f2ca1de3ff09",
    },
    {
      legacyChecksum: "5ae54ddb7f4818fb498e0bda20d54d9c58a53017a22610351c9679be786dca3b",
      variantChecksum: "e4def8f94e12de8fbe6545cc1bf30ab07aa780de211619c9897a9118116dced9",
    },
    {
      legacyChecksum: "e4579148c3ca4b694f8af990504f8d4b8e65796bf26c3949623496d7fc1740e2",
      variantChecksum: "786d19e56069beb7f663926a4991c6f4d8e7f187d100b4b93d6a92f9cbc9a703",
    },
    {
      legacyChecksum: "eadc0c7b63dd080bcb6c27a0f7e17f8e3e71458d5ce7d5b8d0e0fd29920f7f95",
      variantChecksum: "55071786f0f21370c731859b17acd35401d4d97ea544055d4ae4b2c1e67ee738",
    },
    {
      legacyChecksum: "f9e61ca2bd368d2d25c56b9a9d4e92e073080f4955c430c1350bcfc911760ca6",
      variantChecksum: "ce7a4dc2e806c45739946f9f6803fb88e55b8d1f9fbae5ee314a0fbd913b63e8",
    },
    {
      legacyChecksum: "53932d255d65a628188538614d9600d80fa29388d805fb723fefca6f8b8f4633",
      variantChecksum: "58d30b35d578e9da4c49a20130f8415c76c7d0e23c05980ef284c1cf3ab5d067",
    },
    {
      legacyChecksum: "966b02480606ef460994f2fe02992fea148e10f203fb47b1e9f1b8a47485b9ef",
      variantChecksum: "1712e1cb049bec004a7b3459a60a03d00dc974120ee1cdc9b6f33f0f233638d5",
    },
  ]),
});

export interface LegacyNetworking0018StepRow {
  name: string;
  checksum: string;
}

export interface CrosswalkedNetworking0018Step {
  migrationId: "0018";
  variant: "cockroach";
  stepIndex: number;
  legacyChecksum: string;
  variantChecksum: string;
}

export function assertLegacyNetworking0018Crosswalk(
  migration: MigrationDefinition,
): void {
  const crosswalk = LEGACY_NETWORKING_0018_CROSSWALK;
  if (migration.id !== crosswalk.id || migration.variant !== crosswalk.variant) {
    throw new Error("The CockroachDB 0018 legacy crosswalk was used for the wrong migration");
  }
  if (migration.name !== crosswalk.variantName) {
    throw new Error("The CockroachDB 0018 migration filename changed; review its legacy crosswalk");
  }
  if (migration.checksum !== crosswalk.variantFileChecksum || migrationChecksum(migration.source) !== crosswalk.variantFileChecksum) {
    throw new Error("The CockroachDB 0018 SQL changed; update and review its fixed legacy crosswalk");
  }
  if (migration.statements.length !== crosswalk.steps.length) {
    throw new Error("The CockroachDB 0018 statement count no longer matches its legacy crosswalk");
  }
  for (const [index, expected] of crosswalk.steps.entries()) {
    if (statementChecksum(migration.statements[index]) !== expected.variantChecksum) {
      throw new Error(`CockroachDB 0018 statement ${index} no longer matches its legacy crosswalk`);
    }
  }
}

/**
 * Validate and map step rows written by the old semicolon-splitting runner to
 * the explicit Cockroach variant. The old file checksum is optional because an
 * interrupted old run wrote its per-step rows before the final file row.
 */
export function crosswalkLegacyNetworking0018Steps(
  migration: MigrationDefinition,
  legacyFileChecksum: string | undefined,
  rows: LegacyNetworking0018StepRow[],
): CrosswalkedNetworking0018Step[] {
  assertLegacyNetworking0018Crosswalk(migration);
  const crosswalk = LEGACY_NETWORKING_0018_CROSSWALK;
  if (legacyFileChecksum && legacyFileChecksum !== crosswalk.legacyFileChecksum) {
    throw new Error("Legacy CockroachDB 0018 file checksum does not match its fixed provenance");
  }
  if (!legacyFileChecksum && rows.length === 0) {
    throw new Error("Legacy CockroachDB 0018 adoption requires a known file checksum or step rows");
  }

  const mapped: CrosswalkedNetworking0018Step[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const match = /^(?:cockroach\/)?0018_networking_spaces\.sql:step:(\d+)$/.exec(row.name);
    if (!match) throw new Error(`Unexpected legacy 0018 step name: ${row.name}`);
    const stepIndex = Number(match[1]);
    const expected = crosswalk.steps[stepIndex];
    if (!expected) throw new Error(`Legacy CockroachDB 0018 has an unknown step ${stepIndex}`);
    if (seen.has(stepIndex)) throw new Error(`Legacy CockroachDB 0018 repeats step ${stepIndex}`);
    if (row.checksum !== expected.legacyChecksum) {
      throw new Error(`Legacy CockroachDB 0018 step ${stepIndex} checksum does not match its fixed provenance`);
    }
    seen.add(stepIndex);
    mapped.push({
      migrationId: "0018",
      variant: "cockroach",
      stepIndex,
      legacyChecksum: expected.legacyChecksum,
      variantChecksum: expected.variantChecksum,
    });
  }
  return mapped.sort((a, b) => a.stepIndex - b.stepIndex);
}
