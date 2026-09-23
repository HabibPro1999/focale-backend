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
      legacyChecksum: "8842a6fd6caabb48df44b5719242434c4742dc7730fba3fe8ea80acabe4fcdb8",
      variantChecksum: "6efda7d1a2f5b9b42c4f4d3c8376d119442d6ed984f65539dc62260401a503a7",
    },
    {
      legacyChecksum: "18d9ce1a8f993985e4a90315cbf66b901fc95cf75a92bb2d9bfb3bcfe4438637",
      variantChecksum: "d0b6ad4258d86408d13a57f225b1197b2ca9994d6aff6c03f81b7683f58de4b1",
    },
    {
      legacyChecksum: "f05a449e79123d5b44d0c5b0a3a3a59640c7c616d5314d6c9d89550a344b5e6e",
      variantChecksum: "4a6666e96ce8bacbcbb0fa31f7c77c1c95ee5b1675792fedbd89ede60b041027",
    },
    {
      legacyChecksum: "73380e89b857ad4ef56fabf9bd53cbcdd4273c809c7e5ed6401e7045a04387de",
      variantChecksum: "5709043d1c39eadb3bf7c76e1d84e7e8aa06790aba1c99d34261d58d74bf770c",
    },
    {
      legacyChecksum: "31cb1868bd387707015b3e5fc3ba1ea5b2d9882cf62f7348fdf754257fc0d308",
      variantChecksum: "6de3fb41830eae3cd3612e9f7d729d39797e64287ae086254715f2ca1de3ff09",
    },
    {
      legacyChecksum: "e4def8f94e12de8fbe6545cc1bf30ab07aa780de211619c9897a9118116dced9",
      variantChecksum: "e4def8f94e12de8fbe6545cc1bf30ab07aa780de211619c9897a9118116dced9",
    },
    {
      legacyChecksum: "260d7582b58ab5bfb3e13a026eb5f10f514374f686563185f6f466f87ccdec50",
      variantChecksum: "786d19e56069beb7f663926a4991c6f4d8e7f187d100b4b93d6a92f9cbc9a703",
    },
    {
      legacyChecksum: "7e1b3f23fcbbdad97c9d10c55a4d7bb280bb93c446a4a4eaf437422cff2c890b",
      variantChecksum: "55071786f0f21370c731859b17acd35401d4d97ea544055d4ae4b2c1e67ee738",
    },
    {
      legacyChecksum: "fd5cc197f53ebfbb2833bce852a5aa915d6fd39eedf0a8e41ff506537154e69f",
      variantChecksum: "ce7a4dc2e806c45739946f9f6803fb88e55b8d1f9fbae5ee314a0fbd913b63e8",
    },
    {
      legacyChecksum: "58d30b35d578e9da4c49a20130f8415c76c7d0e23c05980ef284c1cf3ab5d067",
      variantChecksum: "58d30b35d578e9da4c49a20130f8415c76c7d0e23c05980ef284c1cf3ab5d067",
    },
    {
      legacyChecksum: "1712e1cb049bec004a7b3459a60a03d00dc974120ee1cdc9b6f33f0f233638d5",
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
