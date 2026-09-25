import {
  and,
  eq,
  gt,
  inArray,
  ne,
  desc,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import { newId } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { certificateTemplates } from "../schema/certificates";
import {
  eventAccess,
  events,
  accessCheckIns,
} from "../schema/events-access";
import { clients } from "../schema/users-clients";
import { registrations } from "../schema/registrations";
import { abstracts } from "../schema/abstracts";
import { emailLogs } from "../schema/email";
import { lockEventForUpdate } from "../locks";
import { withLockingTxn } from "../txn";
import {
  insertEmailLogsSkippingConflicts,
  type EmailLogInsert,
  type EmailLogRow,
  type RegistrationEmailContext,
} from "./email";

type EmailLogStatus = EmailLogRow["status"];

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type CertificateTemplateRow = InferSelectModel<typeof certificateTemplates>;
export type CertificateTemplateInsert = InferInsertModel<
  typeof certificateTemplates
>;

/** access relation projection (legacy `accessSelect = {id,name,type}`). */
export type CertificateAccessRef = { id: string; name: string; type: string };

export type CertificateTemplateWithAccess = CertificateTemplateRow & {
  access: CertificateAccessRef | null;
};

export type CertificateTemplateWithEvent = CertificateTemplateWithAccess & {
  event: { clientId: string; status: string };
};

/** Registration shape the send route needs: full email context + access check-ins. */
export type RegistrationForCertificateSend = RegistrationEmailContext & {
  accessCheckIns: { accessId: string }[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const accessCols = {
  id: eventAccess.id,
  name: eventAccess.name,
  type: eventAccess.type,
} as const;

function toAccessRef(
  row: { accessRefId: string | null; accessRefName: string | null; accessRefType: string | null },
): CertificateAccessRef | null {
  return row.accessRefId
    ? {
        id: row.accessRefId,
        name: row.accessRefName as string,
        type: row.accessRefType as string,
      }
    : null;
}

/** Legacy rows can hold NULL applicableRoles (nullable column); consumers expect an array. */
function withRoles(template: CertificateTemplateRow): CertificateTemplateRow {
  return { ...template, applicableRoles: template.applicableRoles ?? [] };
}

const templateAccessJoin = and(
  eq(eventAccess.id, certificateTemplates.accessId),
  eq(eventAccess.eventId, certificateTemplates.eventId),
);

/** Reload a single template joined with its access relation, or null. */
async function loadTemplateWithAccess(
  id: string,
  exec: DbExecutor,
): Promise<CertificateTemplateWithAccess | null> {
  const rows = await exec
    .select({
      template: certificateTemplates,
      accessRefId: eventAccess.id,
      accessRefName: eventAccess.name,
      accessRefType: eventAccess.type,
    })
    .from(certificateTemplates)
    .leftJoin(eventAccess, templateAccessJoin)
    .where(eq(certificateTemplates.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...withRoles(row.template), access: toAccessRef(row) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All templates for an event (newest first), each with its access {id,name,type}. */
export async function listCertificateTemplates(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<CertificateTemplateWithAccess[]> {
  const rows = await exec
    .select({
      template: certificateTemplates,
      accessRefId: eventAccess.id,
      accessRefName: eventAccess.name,
      accessRefType: eventAccess.type,
    })
    .from(certificateTemplates)
    .leftJoin(eventAccess, templateAccessJoin)
    .where(eq(certificateTemplates.eventId, eventId))
    .orderBy(desc(certificateTemplates.createdAt));
  return rows.map((row) => ({ ...withRoles(row.template), access: toAccessRef(row) }));
}

/** Single template + access relation + owning event's {clientId,status}, or null. */
export async function getCertificateTemplateWithEvent(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<CertificateTemplateWithEvent | null> {
  const rows = await exec
    .select({
      template: certificateTemplates,
      accessRefId: eventAccess.id,
      accessRefName: eventAccess.name,
      accessRefType: eventAccess.type,
      clientId: events.clientId,
      status: events.status,
    })
    .from(certificateTemplates)
    .innerJoin(events, eq(events.id, certificateTemplates.eventId))
    .leftJoin(eventAccess, templateAccessJoin)
    .where(eq(certificateTemplates.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...withRoles(row.template),
    access: toAccessRef(row),
    event: { clientId: row.clientId, status: row.status },
  };
}

/** Minimal projection for the update-time image/relation guard. */
export async function getCertificateTemplateImageState(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<{
  eventId: string;
  templateUrl: string;
  accessId: string | null;
} | null> {
  const [row] = await exec
    .select({
      eventId: certificateTemplates.eventId,
      templateUrl: certificateTemplates.templateUrl,
      accessId: certificateTemplates.accessId,
    })
    .from(certificateTemplates)
    .where(eq(certificateTemplates.id, id))
    .limit(1);
  return row ?? null;
}

/** {id, templateUrl} for delete-time storage cleanup, or null. */
export async function getCertificateTemplateForDelete(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<{ id: string; templateUrl: string } | null> {
  const [row] = await exec
    .select({
      id: certificateTemplates.id,
      templateUrl: certificateTemplates.templateUrl,
    })
    .from(certificateTemplates)
    .where(eq(certificateTemplates.id, id))
    .limit(1);
  return row ?? null;
}

/** {id, eventId, templateUrl} for image-upload (old-image cleanup + key building). */
export async function getCertificateTemplateForUpload(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<{ id: string; eventId: string; templateUrl: string } | null> {
  const [row] = await exec
    .select({
      id: certificateTemplates.id,
      eventId: certificateTemplates.eventId,
      templateUrl: certificateTemplates.templateUrl,
    })
    .from(certificateTemplates)
    .where(eq(certificateTemplates.id, id))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a template. `active` is intentionally NOT set — the schema default
 * (`true`) applies, so a fresh image-less template is `active:true` immediately
 * (legacy gotcha, preserved). Returns the row with its access relation.
 */
export async function createCertificateTemplate(
  values: {
    eventId: string;
    name: string;
    applicableRoles: string[];
    accessId: string | null;
    // H2: optional — omitted means "let the column defaults apply"
    // (scope='BOTH', allowedAbstractFinalTypes=null), i.e. legacy behavior.
    scope?: string;
    allowedAbstractFinalTypes?: string[] | null;
  },
  exec: DbExecutor = getDb(),
): Promise<CertificateTemplateWithAccess> {
  const [inserted] = await exec
    .insert(certificateTemplates)
    .values({
      eventId: values.eventId,
      name: values.name,
      templateUrl: "",
      templateWidth: 0,
      templateHeight: 0,
      applicableRoles: values.applicableRoles as CertificateTemplateInsert["applicableRoles"],
      accessId: values.accessId,
      ...(values.scope !== undefined
        ? { scope: values.scope as CertificateTemplateInsert["scope"] }
        : {}),
      ...(values.allowedAbstractFinalTypes !== undefined
        ? {
            allowedAbstractFinalTypes:
              values.allowedAbstractFinalTypes as CertificateTemplateInsert["allowedAbstractFinalTypes"],
          }
        : {}),
    })
    .returning();
  return (await loadTemplateWithAccess(inserted.id, exec)) as CertificateTemplateWithAccess;
}

/**
 * Update a template with a sparse column patch, returning the row + access.
 * `accessId` is a plain nullable column here (no Prisma connect/disconnect);
 * setting it to null unlinks, to a uuid links. The service verifies that the
 * access row belongs to this template's event before this query runs.
 */
export async function updateCertificateTemplate(
  id: string,
  patch: {
    name?: string;
    zones?: unknown;
    applicableRoles?: string[];
    active?: boolean;
    accessId?: string | null;
    // H2
    scope?: string;
    allowedAbstractFinalTypes?: string[] | null;
  },
  exec: DbExecutor = getDb(),
): Promise<CertificateTemplateWithAccess> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.zones !== undefined) set.zones = patch.zones;
  if (patch.applicableRoles !== undefined) set.applicableRoles = patch.applicableRoles;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.accessId !== undefined) set.accessId = patch.accessId;
  if (patch.scope !== undefined) set.scope = patch.scope;
  if (patch.allowedAbstractFinalTypes !== undefined) {
    set.allowedAbstractFinalTypes = patch.allowedAbstractFinalTypes;
  }

  await exec
    .update(certificateTemplates)
    .set(set)
    .where(eq(certificateTemplates.id, id));
  return (await loadTemplateWithAccess(id, exec)) as CertificateTemplateWithAccess;
}

/** Persist the uploaded image url + original dimensions; return row + access. */
export async function updateCertificateTemplateImage(
  id: string,
  data: { templateUrl: string; templateWidth: number; templateHeight: number },
  exec: DbExecutor = getDb(),
): Promise<CertificateTemplateWithAccess> {
  await exec
    .update(certificateTemplates)
    .set({
      templateUrl: data.templateUrl,
      templateWidth: data.templateWidth,
      templateHeight: data.templateHeight,
    })
    .where(eq(certificateTemplates.id, id));
  return (await loadTemplateWithAccess(id, exec)) as CertificateTemplateWithAccess;
}

export async function deleteCertificateTemplateById(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec.delete(certificateTemplates).where(eq(certificateTemplates.id, id));
}

// ---------------------------------------------------------------------------
// Send route + worker reads
// ---------------------------------------------------------------------------

/**
 * Active, image-ready templates for an event (send route §1.8 step 2). Only
 * templates with a real image (templateUrl != '' AND both dimensions > 0) —
 * image-less "active" templates are silently excluded from sends. access {id,name,type}.
 */
export async function listActiveImageReadyCertificateTemplates(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<CertificateTemplateWithAccess[]> {
  const rows = await exec
    .select({
      template: certificateTemplates,
      accessRefId: eventAccess.id,
      accessRefName: eventAccess.name,
      accessRefType: eventAccess.type,
    })
    .from(certificateTemplates)
    .leftJoin(eventAccess, templateAccessJoin)
    .where(
      and(
        eq(certificateTemplates.eventId, eventId),
        eq(certificateTemplates.active, true),
        ne(certificateTemplates.templateUrl, ""),
        gt(certificateTemplates.templateWidth, 0),
        gt(certificateTemplates.templateHeight, 0),
      ),
    );
  return rows.map((row) => ({ ...withRoles(row.template), access: toAccessRef(row) }));
}

/**
 * Templates by ids re-validated at send time (worker §5): active + image-ready +
 * scoped to the registration's event. access {id,name,type}.
 */
export async function getActiveImageReadyCertificateTemplatesByIds(
  ids: string[],
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<CertificateTemplateWithAccess[]> {
  if (ids.length === 0) return [];
  const rows = await exec
    .select({
      template: certificateTemplates,
      accessRefId: eventAccess.id,
      accessRefName: eventAccess.name,
      accessRefType: eventAccess.type,
    })
    .from(certificateTemplates)
    .leftJoin(eventAccess, templateAccessJoin)
    .where(
      and(
        inArray(certificateTemplates.id, ids),
        eq(certificateTemplates.active, true),
        eq(certificateTemplates.eventId, eventId),
        ne(certificateTemplates.templateUrl, ""),
        gt(certificateTemplates.templateWidth, 0),
        gt(certificateTemplates.templateHeight, 0),
      ),
    );
  return rows.map((row) => ({ ...withRoles(row.template), access: toAccessRef(row) }));
}

/**
 * Registrations for the send route. `registrationIds === undefined` → all
 * registrations of the event; an explicit (possibly empty) array → only those ids
 * (empty array matches none — legacy `id: { in: [] }`). Each row carries its
 * accessCheckIns + full email context (event + client) for eligibility + context
 * building.
 */
export async function getRegistrationsForCertificateSend(
  eventId: string,
  registrationIds: string[] | undefined,
  exec: DbExecutor = getDb(),
): Promise<RegistrationForCertificateSend[]> {
  const conds: SQL[] = [eq(registrations.eventId, eventId)];
  if (registrationIds !== undefined) {
    conds.push(inArray(registrations.id, registrationIds));
  }

  const rows = await exec
    .select({
      registration: registrations,
      event: events,
      client: { name: clients.name, email: clients.email, phone: clients.phone },
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(and(...conds));

  if (rows.length === 0) return [];

  const regIds = rows.map((r) => r.registration.id);
  const checkIns = await exec
    .select({
      registrationId: accessCheckIns.registrationId,
      accessId: accessCheckIns.accessId,
    })
    .from(accessCheckIns)
    .where(inArray(accessCheckIns.registrationId, regIds));

  const checkInsByReg = new Map<string, { accessId: string }[]>();
  for (const c of checkIns) {
    const list = checkInsByReg.get(c.registrationId) ?? [];
    list.push({ accessId: c.accessId });
    checkInsByReg.set(c.registrationId, list);
  }

  return rows.map((r) => ({
    ...r.registration,
    event: { ...r.event, client: r.client },
    accessCheckIns: checkInsByReg.get(r.registration.id) ?? [],
  }));
}

/** Registration projection the worker re-fetches to render certificate PDFs (§5). */
export async function getRegistrationForCertificateGeneration(
  registrationId: string,
  exec: DbExecutor = getDb(),
): Promise<{
  id: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  checkedInAt: Date | null;
  accessCheckIns: { accessId: string }[];
  event: { id: string; name: string; startDate: Date; location: string | null };
} | null> {
  const [row] = await exec
    .select({
      id: registrations.id,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      role: registrations.role,
      checkedInAt: registrations.checkedInAt,
      eventId: events.id,
      eventName: events.name,
      eventStartDate: events.startDate,
      eventLocation: events.location,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!row) return null;

  const checkIns = await exec
    .select({ accessId: accessCheckIns.accessId })
    .from(accessCheckIns)
    .where(eq(accessCheckIns.registrationId, registrationId));

  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    checkedInAt: row.checkedInAt,
    accessCheckIns: checkIns,
    event: {
      id: row.eventId,
      name: row.eventName,
      startDate: row.eventStartDate,
      location: row.eventLocation,
    },
  };
}

/** Abstract projection the worker re-fetches to render certificate PDFs (H2, mirrors
 * getRegistrationForCertificateGeneration). */
export interface AbstractForCertificateGeneration {
  id: string;
  authorFirstName: string;
  authorLastName: string;
  finalType: string | null;
  requestedType: string;
  code: string | null;
  content: unknown;
  event: { id: string; name: string; startDate: Date; location: string | null };
}

export async function getAbstractForCertificateGeneration(
  abstractId: string,
  exec: DbExecutor = getDb(),
): Promise<AbstractForCertificateGeneration | null> {
  const [row] = await exec
    .select({
      id: abstracts.id,
      authorFirstName: abstracts.authorFirstName,
      authorLastName: abstracts.authorLastName,
      finalType: abstracts.finalType,
      requestedType: abstracts.requestedType,
      code: abstracts.code,
      content: abstracts.content,
      eventId: events.id,
      eventName: events.name,
      eventStartDate: events.startDate,
      eventLocation: events.location,
    })
    .from(abstracts)
    .innerJoin(events, eq(events.id, abstracts.eventId))
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    authorFirstName: row.authorFirstName,
    authorLastName: row.authorLastName,
    finalType: row.finalType,
    requestedType: row.requestedType,
    code: row.code,
    content: row.content,
    event: {
      id: row.eventId,
      name: row.eventName,
      startDate: row.eventStartDate,
      location: row.eventLocation,
    },
  };
}

/**
 * Certificate email statuses that count as "already sent": queued, in flight,
 * or sent (a delivered email that was later opened or clicked is still sent).
 * UNCERTAIN counts too: the provider may already have sent it, so a repeated
 * send must not queue a second email; an admin resends it explicitly through
 * the email-log resend route. BOUNCED, DROPPED, FAILED and SKIPPED
 * certificates can be sent again.
 */
export const CERTIFICATE_EMAIL_SENT_STATUSES = [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "OPENED",
  "CLICKED",
  "UNCERTAIN",
] as const satisfies readonly EmailLogStatus[];

/**
 * Per-registration set of certificate template ids already queued/sent. Reads
 * CERTIFICATE_SENT EmailLog rows in CERTIFICATE_EMAIL_SENT_STATUSES and
 * extracts the durable dedupe key stashed in
 * `contextSnapshot._certificateTemplateIds` (string entries only).
 */
export async function getAlreadySentCertTemplateIds(
  registrationIds: string[],
  exec: DbExecutor = getDb(),
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (registrationIds.length === 0) return map;

  const rows = await exec
    .select({
      registrationId: emailLogs.registrationId,
      contextSnapshot: emailLogs.contextSnapshot,
    })
    .from(emailLogs)
    .where(
      and(
        inArray(emailLogs.registrationId, registrationIds),
        eq(emailLogs.trigger, "CERTIFICATE_SENT"),
        inArray(emailLogs.status, CERTIFICATE_EMAIL_SENT_STATUSES),
      ),
    );

  for (const row of rows) {
    if (!row.registrationId) continue;
    const snapshot = row.contextSnapshot as
      | { _certificateTemplateIds?: unknown }
      | null;
    const ids = snapshot?._certificateTemplateIds;
    if (!Array.isArray(ids)) continue;
    const set = map.get(row.registrationId) ?? new Set<string>();
    for (const id of ids) {
      if (typeof id === "string") set.add(id);
    }
    map.set(row.registrationId, set);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Abstract certificate send route reads (H2)
// ---------------------------------------------------------------------------

/** Abstract projection the certificate send route needs for eligibility + context. */
export interface AbstractForCertificateSend {
  id: string;
  eventId: string;
  status: string;
  presentedAt: Date | null;
  finalType: string | null;
  requestedType: string;
  code: string | null;
  content: unknown;
  authorFirstName: string;
  authorLastName: string;
  authorEmail: string;
  event: { name: string; startDate: Date; location: string | null };
}

/**
 * Abstracts by id, scoped to the event (send route eligibility check §H2).
 * Ids that don't exist or belong to a different event are simply absent from
 * the result — the caller reports those as ineligible ("not found for this
 * event") rather than failing the whole request.
 */
export async function getAbstractsForCertificateSend(
  eventId: string,
  abstractIds: string[],
  exec: DbExecutor = getDb(),
): Promise<AbstractForCertificateSend[]> {
  if (abstractIds.length === 0) return [];

  const rows = await exec
    .select({
      id: abstracts.id,
      eventId: abstracts.eventId,
      status: abstracts.status,
      presentedAt: abstracts.presentedAt,
      finalType: abstracts.finalType,
      requestedType: abstracts.requestedType,
      code: abstracts.code,
      content: abstracts.content,
      authorFirstName: abstracts.authorFirstName,
      authorLastName: abstracts.authorLastName,
      authorEmail: abstracts.authorEmail,
      eventName: events.name,
      eventStartDate: events.startDate,
      eventLocation: events.location,
    })
    .from(abstracts)
    .innerJoin(events, eq(events.id, abstracts.eventId))
    .where(
      and(eq(abstracts.eventId, eventId), inArray(abstracts.id, abstractIds)),
    );

  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    status: r.status,
    presentedAt: r.presentedAt,
    finalType: r.finalType,
    requestedType: r.requestedType,
    code: r.code,
    content: r.content,
    authorFirstName: r.authorFirstName,
    authorLastName: r.authorLastName,
    authorEmail: r.authorEmail,
    event: {
      name: r.eventName,
      startDate: r.eventStartDate,
      location: r.eventLocation,
    },
  }));
}

/**
 * Per-abstract set of certificate template ids already queued/sent, mirroring
 * getAlreadySentCertTemplateIds but scoped to emailLogs.abstractId instead of
 * registrationId (H2 dedupe).
 */
export async function getAlreadySentAbstractCertTemplateIds(
  abstractIds: string[],
  exec: DbExecutor = getDb(),
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (abstractIds.length === 0) return map;

  const rows = await exec
    .select({
      abstractId: emailLogs.abstractId,
      contextSnapshot: emailLogs.contextSnapshot,
    })
    .from(emailLogs)
    .where(
      and(
        inArray(emailLogs.abstractId, abstractIds),
        eq(emailLogs.trigger, "CERTIFICATE_SENT"),
        inArray(emailLogs.status, CERTIFICATE_EMAIL_SENT_STATUSES),
      ),
    );

  for (const row of rows) {
    if (!row.abstractId) continue;
    const snapshot = row.contextSnapshot as
      | { _certificateTemplateIds?: unknown }
      | null;
    const ids = snapshot?._certificateTemplateIds;
    if (!Array.isArray(ids)) continue;
    const set = map.get(row.abstractId) ?? new Set<string>();
    for (const id of ids) {
      if (typeof id === "string") set.add(id);
    }
    map.set(row.abstractId, set);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Certificate send write (2.12)
// ---------------------------------------------------------------------------

/** One recipient of a certificate send: a registration or an abstract. */
export interface CertificateEmailCandidate {
  /** Registration id in the registration batch, abstract id in the abstract batch. */
  targetId: string;
  recipientEmail: string;
  recipientName: string | null;
  /** Certificate templates this recipient is eligible for, in display order. */
  certificates: ReadonlyArray<{ id: string; name: string }>;
  /** Email context; the certificate keys are added per queued row. */
  contextSnapshot: Record<string, unknown>;
}

export type CertificateEmailOutcome =
  | {
      status: "queued";
      emailLogId: string;
      /** The certificates this email carries (eligible minus already sent). */
      certificates: Array<{ id: string; name: string }>;
    }
  /** Every eligible certificate was already queued or sent. */
  | { status: "already_sent" }
  /** A unique index refused the row; nothing was queued for this recipient. */
  | { status: "skipped_conflict" };

export interface QueueCertificateEmailLogsInput {
  eventId: string;
  /** The event's CERTIFICATE_SENT email template. */
  emailTemplateId: string;
  registrations: readonly CertificateEmailCandidate[];
  abstracts: readonly CertificateEmailCandidate[];
}

export interface QueueCertificateEmailLogsResult {
  /** One outcome per input candidate, in input order. */
  registrations: CertificateEmailOutcome[];
  abstracts: CertificateEmailOutcome[];
}

/** A candidate after the already-sent check: nothing to send, or a row to insert. */
export type PlannedCertificateEmail =
  | { status: "already_sent" }
  | {
      status: "insert";
      row: EmailLogInsert & { id: string };
      certificates: Array<{ id: string; name: string }>;
    };

/**
 * Pure part of queueCertificateEmailLogsTxn: drop the certificates each
 * candidate already has and build one QUEUED row per candidate with the rest.
 * `_certificateTemplateIds` is the durable dedupe key and the list of
 * templates the worker attaches at send time. Takes the sent maps by value.
 */
export function planCertificateEmailLogs(
  input: QueueCertificateEmailLogsInput,
  sentByRegistration: ReadonlyMap<string, ReadonlySet<string>>,
  sentByAbstract: ReadonlyMap<string, ReadonlySet<string>>,
): { registrations: PlannedCertificateEmail[]; abstracts: PlannedCertificateEmail[] } {
  const plan = (
    candidates: readonly CertificateEmailCandidate[],
    sentByTarget: ReadonlyMap<string, ReadonlySet<string>>,
    target: "registration" | "abstract",
  ): PlannedCertificateEmail[] => {
    // Covered so far, including rows planned earlier in this call, so a
    // target listed twice gets its certificates once.
    const covered = new Map<string, Set<string>>();
    return candidates.map((candidate) => {
      const done =
        covered.get(candidate.targetId) ??
        new Set(sentByTarget.get(candidate.targetId) ?? []);
      covered.set(candidate.targetId, done);
      const remaining = candidate.certificates
        .filter((certificate) => !done.has(certificate.id))
        .map(({ id, name }) => ({ id, name }));
      if (remaining.length === 0) return { status: "already_sent" };
      for (const { id } of remaining) done.add(id);
      return {
        status: "insert",
        certificates: remaining,
        row: {
          id: newId(),
          trigger: "CERTIFICATE_SENT",
          templateId: input.emailTemplateId,
          ...(target === "registration"
            ? { registrationId: candidate.targetId }
            : { abstractId: candidate.targetId }),
          recipientEmail: candidate.recipientEmail,
          recipientName: candidate.recipientName,
          subject: "",
          status: "QUEUED",
          contextSnapshot: {
            ...candidate.contextSnapshot,
            certificateCount: String(remaining.length),
            certificateList: remaining.map((c) => c.name).join(", "),
            _certificateTemplateIds: remaining.map((c) => c.id),
          },
        },
      };
    });
  };
  return {
    registrations: plan(input.registrations, sentByRegistration, "registration"),
    abstracts: plan(input.abstracts, sentByAbstract, "abstract"),
  };
}

/**
 * Queue certificate emails for both batches in one transaction. Locks the
 * event first (whole-event work, ADR 0001), so concurrent sends for the same
 * event run one after the other; then re-reads which certificates each
 * registration and abstract already has and queues one email per recipient
 * with the remaining ones. The insert skips rows a unique index refuses
 * (`skipped_conflict`) instead of failing the send. Both batches commit or
 * roll back together. Returns null when the event no longer exists.
 */
export async function queueCertificateEmailLogsTxn(
  input: QueueCertificateEmailLogsInput,
): Promise<QueueCertificateEmailLogsResult | null> {
  if (input.registrations.length === 0 && input.abstracts.length === 0) {
    return { registrations: [], abstracts: [] };
  }

  return withLockingTxn(async (tx) => {
    if (!(await lockEventForUpdate(tx, input.eventId))) return null;

    const plan = planCertificateEmailLogs(
      input,
      await getAlreadySentCertTemplateIds(
        input.registrations.map((c) => c.targetId),
        tx,
      ),
      await getAlreadySentAbstractCertTemplateIds(
        input.abstracts.map((c) => c.targetId),
        tx,
      ),
    );
    const inserted = await insertEmailLogsSkippingConflicts(
      [...plan.registrations, ...plan.abstracts].flatMap((p) =>
        p.status === "insert" ? [p.row] : [],
      ),
      tx,
    );

    const outcome = (p: PlannedCertificateEmail): CertificateEmailOutcome => {
      if (p.status === "already_sent") return p;
      return inserted.has(p.row.id)
        ? { status: "queued", emailLogId: p.row.id, certificates: p.certificates }
        : { status: "skipped_conflict" };
    };
    return {
      registrations: plan.registrations.map(outcome),
      abstracts: plan.abstracts.map(outcome),
    };
  });
}
