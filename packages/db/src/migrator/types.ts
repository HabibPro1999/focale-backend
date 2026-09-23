import type { Client } from "pg";
import type { DatabaseEngine, MigrationDefinition, MigrationVariant } from "./migration";

export type MigrationStatus = "applied" | "baseline" | "deferred";

export interface SchemaMigrationRecord {
  id: string;
  variant: MigrationVariant;
  checksum: string;
  status: MigrationStatus;
  applied_at: Date | string;
  applied_by: string;
  evidence: Record<string, unknown>;
}

export interface SchemaMigrationStepRecord {
  migration_id: string;
  variant: MigrationVariant;
  step_index: number;
  checksum: string;
  applied_at: Date | string;
  applied_by: string;
}

export type CatalogObjectKind = "table" | "column" | "index" | "constraint" | "type" | "extension";

export interface CatalogObjectProbe {
  migrationId: string;
  variant: MigrationVariant;
  statementIndex: number;
  kind: CatalogObjectKind;
  name: string;
  table?: string;
  expectedPresent: boolean;
  source: "ddl" | "manifest" | "directive";
}

export interface CatalogSqlProbe {
  migrationId: string;
  variant: MigrationVariant;
  query: string;
  source: "verify";
}

export interface MigrationCatalogReport {
  migrationId: string;
  variant: MigrationVariant;
  matched: number;
  total: number;
  state: "all" | "none" | "partial" | "unverifiable";
  probes: Array<{ probe: CatalogObjectProbe | CatalogSqlProbe; passed: boolean }>;
}

export type AdoptionClassification = "applied" | "baseline" | "pending" | "deferred";

export interface AdoptionAssessment {
  migration: MigrationDefinition;
  classification: AdoptionClassification;
  evidence: Record<string, unknown>;
  catalog: MigrationCatalogReport;
}

/**
 * Boundary shared with item 1.4. The CLI dispatches to an AdoptionWorkflow;
 * item 1.2 intentionally does not infer or write baselines for existing DBs.
 */
export interface MigrationAdoptionOptions {
  writeLedger: boolean;
  appliedBy: string;
}

export interface MigrationAdoptionReport {
  engine: DatabaseEngine;
  assessments: AdoptionAssessment[];
  warnings: string[];
}

export interface MigrationLedgerAccess {
  ensureSchema(client: Client): Promise<void>;
  listMigrations(client: Client): Promise<SchemaMigrationRecord[]>;
  listSteps(
    client: Client,
    migrationId: string,
    variant: MigrationVariant,
  ): Promise<SchemaMigrationStepRecord[]>;
  writeMigration(
    client: Client,
    migration: MigrationDefinition,
    status: MigrationStatus,
    appliedBy: string,
    evidence: Record<string, unknown>,
  ): Promise<void>;
  writeStep(
    client: Client,
    migration: MigrationDefinition,
    stepIndex: number,
    appliedBy: string,
  ): Promise<void>;
}

export interface MigrationCatalogAccess {
  inspect(
    client: Client,
    engine: DatabaseEngine,
    migration: MigrationDefinition,
  ): Promise<MigrationCatalogReport>;
}

export interface MigrationAdoptionSupport {
  ledger: MigrationLedgerAccess;
  catalog: MigrationCatalogAccess;
}

export interface MigrationAdoptionWorkflow {
  run(
    client: Client,
    engine: DatabaseEngine,
    migrations: MigrationDefinition[],
    options: MigrationAdoptionOptions,
    support: MigrationAdoptionSupport,
  ): Promise<MigrationAdoptionReport>;
}
