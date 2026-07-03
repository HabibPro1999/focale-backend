import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  sql,
  type InferInsertModel,
  type InferSelectModel,
} from "drizzle-orm";
import { createLogger } from "@app/shared";
import { getSponsorshipMode, extractFieldIds } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { withSerializableTxn, pgUniqueViolation } from "../txn";
import { forms } from "../schema/forms";
import { events, eventAccess } from "../schema/events-access";
import { clients } from "../schema/users-clients";
import { eventPricing } from "../schema/pricing";
import { registrations } from "../schema/registrations";
import { sponsorshipBatches } from "../schema/sponsorships";

const logger = createLogger({ name: "db:forms" });

export type Form = InferSelectModel<typeof forms>;
export type FormInsert = InferInsertModel<typeof forms>;
export type FormType = Form["type"];

/** Form row with the slim event projection used for ownership/gate checks. */
export type FormWithEvent = Form & {
  event: {
    clientId: string;
    status: (typeof events.$inferSelect)["status"];
    endDate: Date;
  };
};

type ClientPublic = Pick<
  typeof clients.$inferSelect,
  "id" | "name" | "logo" | "primaryColor" | "phone"
>;

/** Full public form payload (registration or sponsor public routes). */
export type FormWithRelations = Form & {
  event: typeof events.$inferSelect & {
    client: ClientPublic;
    pricing: typeof eventPricing.$inferSelect | null;
    access: (typeof eventAccess.$inferSelect)[];
  };
};

export type FormUpdatePatch = {
  name?: string;
  successTitle?: string | null;
  successMessage?: string | null;
  schema?: unknown;
  incrementSchemaVersion?: boolean;
};

type ModeChangeResult<R extends string> =
  | { ok: true; form: Form }
  | { ok: false; reason: R };

// ============================================================================
// Reads
// ============================================================================

export async function findFormById(id: string): Promise<Form | null> {
  return findFormByIdExec(id, getDb());
}

async function findFormByIdExec(
  id: string,
  exec: DbExecutor,
): Promise<Form | null> {
  const [row] = await exec
    .select()
    .from(forms)
    .where(eq(forms.id, id))
    .limit(1);
  return row ?? null;
}

export async function findFormByIdWithEvent(
  id: string,
): Promise<FormWithEvent | null> {
  const [row] = await getDb()
    .select({
      form: forms,
      clientId: events.clientId,
      status: events.status,
      endDate: events.endDate,
    })
    .from(forms)
    .innerJoin(events, eq(forms.eventId, events.id))
    .where(eq(forms.id, id))
    .limit(1);
  if (!row) return null;
  return {
    ...row.form,
    event: { clientId: row.clientId, status: row.status, endDate: row.endDate },
  };
}

export async function findActiveRegistrationFormById(
  id: string,
): Promise<FormWithEvent | null> {
  const [row] = await getDb()
    .select({
      form: forms,
      clientId: events.clientId,
      status: events.status,
      endDate: events.endDate,
    })
    .from(forms)
    .innerJoin(events, eq(forms.eventId, events.id))
    .where(
      and(
        eq(forms.id, id),
        eq(forms.type, "REGISTRATION"),
        eq(forms.active, true),
        eq(events.status, "OPEN"),
        gte(events.endDate, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...row.form,
    event: { clientId: row.clientId, status: row.status, endDate: row.endDate },
  };
}

async function findPublicFormByEventSlug(
  slug: string,
  type: FormType,
  requiredModule: string,
): Promise<FormWithRelations | null> {
  const [row] = await getDb()
    .select({
      form: forms,
      event: events,
      client: {
        id: clients.id,
        name: clients.name,
        logo: clients.logo,
        primaryColor: clients.primaryColor,
        phone: clients.phone,
      },
      pricing: eventPricing,
    })
    .from(forms)
    .innerJoin(events, eq(forms.eventId, events.id))
    .innerJoin(clients, eq(events.clientId, clients.id))
    .leftJoin(eventPricing, eq(eventPricing.eventId, events.id))
    .where(
      and(
        eq(forms.type, type),
        eq(forms.active, true),
        eq(events.slug, slug),
        eq(events.status, "OPEN"),
        gte(events.endDate, new Date()),
        eq(clients.active, true),
        arrayContains(clients.enabledModules, [requiredModule]),
      ),
    )
    .limit(1);
  if (!row) return null;

  const access = await getDb()
    .select()
    .from(eventAccess)
    .where(and(eq(eventAccess.eventId, row.event.id), eq(eventAccess.active, true)))
    .orderBy(
      asc(eventAccess.startsAt),
      asc(eventAccess.sortOrder),
      asc(eventAccess.createdAt),
    );

  return {
    ...row.form,
    event: {
      ...row.event,
      client: row.client,
      pricing: row.pricing,
      access,
    },
  };
}

export function findRegistrationFormByEventSlug(
  slug: string,
): Promise<FormWithRelations | null> {
  return findPublicFormByEventSlug(slug, "REGISTRATION", "registrations");
}

export function findSponsorFormByEventSlug(
  slug: string,
): Promise<FormWithRelations | null> {
  return findPublicFormByEventSlug(slug, "SPONSOR", "sponsorships");
}

export async function findSponsorFormByEventId(
  eventId: string,
): Promise<Form | null> {
  const [row] = await getDb()
    .select()
    .from(forms)
    .where(and(eq(forms.eventId, eventId), eq(forms.type, "SPONSOR")))
    .limit(1);
  return row ?? null;
}

export async function formExistsByEventAndType(
  eventId: string,
  type: FormType,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: forms.id })
    .from(forms)
    .where(and(eq(forms.eventId, eventId), eq(forms.type, type)))
    .limit(1);
  return row !== undefined;
}

export async function countRegistrationsByFormId(
  formId: string,
  exec: DbExecutor = getDb(),
): Promise<number> {
  const [row] = await exec
    .select({ n: count() })
    .from(registrations)
    .where(eq(registrations.formId, formId));
  return row?.n ?? 0;
}

export async function countSponsorshipBatchesByFormId(
  formId: string,
  exec: DbExecutor = getDb(),
): Promise<number> {
  const [row] = await exec
    .select({ n: count() })
    .from(sponsorshipBatches)
    .where(eq(sponsorshipBatches.formId, formId));
  return row?.n ?? 0;
}

export async function listForms(
  filters: { eventId?: string; type?: FormType; search?: string },
  skip: number,
  take: number,
): Promise<{ data: Form[]; total: number }> {
  const conds = [];
  if (filters.eventId) conds.push(eq(forms.eventId, filters.eventId));
  if (filters.type) conds.push(eq(forms.type, filters.type));
  if (filters.search) conds.push(ilike(forms.name, `%${filters.search}%`));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [data, totalRows] = await Promise.all([
    getDb()
      .select()
      .from(forms)
      .where(where)
      .orderBy(desc(forms.createdAt))
      .offset(skip)
      .limit(take),
    getDb().select({ n: count() }).from(forms).where(where),
  ]);
  return { data, total: totalRows[0]?.n ?? 0 };
}

// ============================================================================
// Writes
// ============================================================================

/**
 * Insert a form. The (event_id, type) unique index backs the app-level
 * pre-check; a losing race surfaces as pg 23505 → { ok:false, reason:"conflict" }
 * so callers reproduce the legacy generic 409.
 */
export async function insertForm(
  values: FormInsert,
): Promise<{ ok: true; form: Form } | { ok: false; reason: "conflict" }> {
  try {
    const [form] = await getDb().insert(forms).values(values).returning();
    return { ok: true, form };
  } catch (err) {
    if (pgUniqueViolation(err) !== null) {
      return { ok: false, reason: "conflict" };
    }
    throw err;
  }
}

function buildFormSet(patch: FormUpdatePatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.successTitle !== undefined) set.successTitle = patch.successTitle;
  if (patch.successMessage !== undefined)
    set.successMessage = patch.successMessage;
  if (patch.schema !== undefined) set.schema = patch.schema;
  if (patch.incrementSchemaVersion) {
    set.schemaVersion = sql`${forms.schemaVersion} + 1`;
  }
  return set;
}

/**
 * Generic non-transactional form update. An empty patch still issues a write
 * (updatedAt-only) to mirror Prisma's `update({ data: {} })` no-op round trip.
 */
export async function updateForm(
  id: string,
  patch: FormUpdatePatch,
): Promise<Form> {
  const set = buildFormSet(patch);
  if (Object.keys(set).length === 0) set.updatedAt = new Date();
  const [form] = await getDb()
    .update(forms)
    .set(set)
    .where(eq(forms.id, id))
    .returning();
  return form;
}

export async function deleteFormById(id: string): Promise<void> {
  await getDb().delete(forms).where(eq(forms.id, id));
}

/**
 * SPONSOR form schema update whose sponsorship mode is changing. Runs
 * serializable so the lock check + write are atomic against concurrent batch
 * creation / mode changes.
 */
export function updateSponsorFormSchemaModeChange(params: {
  id: string;
  patch: FormUpdatePatch;
  nextSchema: unknown;
  newMode: string;
}): Promise<ModeChangeResult<"not_found" | "type_changed" | "locked">> {
  return withSerializableTxn(async (tx) => {
    const current = await findFormByIdExec(params.id, tx);
    if (!current) return { ok: false, reason: "not_found" } as const;
    if (current.type !== "SPONSOR") {
      return { ok: false, reason: "type_changed" } as const;
    }
    if (getSponsorshipMode(current.schema) !== params.newMode) {
      const batches = await countSponsorshipBatchesByFormId(params.id, tx);
      if (batches > 0) return { ok: false, reason: "locked" } as const;
    }

    const newFieldIds = extractFieldIds(params.nextSchema);
    const removed = extractFieldIds(current.schema).filter(
      (fieldId) => !newFieldIds.includes(fieldId),
    );
    if (removed.length > 0) {
      const regCount = await countRegistrationsByFormId(params.id, tx);
      if (regCount > 0) {
        logger.warn(
          { formId: params.id, removedFields: removed, affectedRegistrations: regCount },
          "Form fields removed with existing registration data - data may be orphaned",
        );
      }
    }

    const [form] = await tx
      .update(forms)
      .set({
        ...buildFormSet(params.patch),
        schema: params.nextSchema,
        schemaVersion: sql`${forms.schemaVersion} + 1`,
      })
      .where(eq(forms.id, params.id))
      .returning();
    return { ok: true, form } as const;
  });
}

/**
 * updateSponsorshipSettings mode-change path (serializable). Re-reads, re-checks
 * the lock against tx-fresh state, then shallow-merges settings into
 * schema.sponsorshipSettings. No schemaVersion bump (matches legacy).
 */
export function updateSponsorshipSettingsModeChange(
  formId: string,
  settings: { sponsorshipMode: string } & Record<string, unknown>,
): Promise<ModeChangeResult<"not_found" | "not_sponsor" | "locked">> {
  return withSerializableTxn(async (tx) => {
    const current = await findFormByIdExec(formId, tx);
    if (!current) return { ok: false, reason: "not_found" } as const;
    if (current.type !== "SPONSOR") {
      return { ok: false, reason: "not_sponsor" } as const;
    }
    if (getSponsorshipMode(current.schema) !== settings.sponsorshipMode) {
      const batches = await countSponsorshipBatchesByFormId(formId, tx);
      if (batches > 0) return { ok: false, reason: "locked" } as const;
    }

    const schema = (current.schema ?? {}) as Record<string, unknown>;
    const merged = {
      ...schema,
      sponsorshipSettings: {
        ...((schema.sponsorshipSettings as Record<string, unknown>) ?? {}),
        ...settings,
      },
    };
    const [form] = await tx
      .update(forms)
      .set({ schema: merged })
      .where(eq(forms.id, formId))
      .returning();
    return { ok: true, form } as const;
  });
}
