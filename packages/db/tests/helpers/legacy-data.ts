import type { Client } from "pg";
import {
  adoptMigrations,
  applyMigrations,
  defaultMigrationsDirectory,
  loadMigrations,
  migrationAdoptionSupport,
  type ApplyMigrationsResult,
} from "../../src/migrator";
import type { ScratchDatabase } from "../../src/testing/database";
import { createLegacyPrismaDatabase } from "./legacy-prisma";

// Production data as the legacy app leaves it: rows in every table of the
// legacy Prisma schema (createLegacyPrismaDatabase), written the way main's
// writers write them (backend commit 0f86c91d; each section names its
// writer). The data-preservation tests seed it before `adopt` and follow it
// through every migration. It runs on PostgreSQL and CockroachDB.
//
// Amounts follow legacy's conventions, not Nest's: a signup sponsorship code
// stores the net total (registrations.service.ts:448), an admin link keeps
// the stored total and leaves the breakdown untouched
// (sponsorship-linking.ts:571-662), an admin edit of a linked registration
// stores the net total again (registrations.service.ts:1217), and an admin
// create with a settled status stores no paid amount
// (registrations.service.ts:667-697).

const KINDS = {
  client: 1,
  user: 2,
  event: 3,
  form: 4,
  pricing: 5,
  access: 6,
  batch: 7,
  sponsorship: 8,
  usage: 9,
  registration: 10,
  transaction: 11,
  checkIn: 12,
  certificate: 13,
  emailTemplate: 14,
  emailLog: 15,
  outbox: 16,
  audit: 17,
  abstractConfig: 18,
  theme: 19,
  counter: 20,
  sequence: 21,
  bookJob: 22,
  abstract: 23,
  membership: 24,
  inviteToken: 25,
  review: 26,
  reviewerTheme: 27,
  revision: 28,
  themeLink: 29,
  rule: 30,
  idempotency: 31,
} as const;

/** A UUID like Prisma's @default(uuid()), readable by kind and number; ascending with `n`. */
function uid(kind: keyof typeof KINDS, n: number): string {
  return `${KINDS[kind].toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** 64 hex characters, like generateEditToken (randomBytes(32).toString("hex")). */
function token(seed: number): string {
  return seed.toString(16).padStart(8, "0").repeat(8);
}

export const LEGACY_IDS = {
  client: { main: uid("client", 1), other: uid("client", 2) },
  user: {
    superAdmin: uid("user", 1),
    admin: uid("user", 2),
    reviewer1: uid("user", 3),
    reviewer2: uid("user", 4),
    reviewer3: uid("user", 5),
    otherAdmin: uid("user", 6),
  },
  event: { congress: uid("event", 1), pastDays: uid("event", 2), archived: uid("event", 3) },
  form: {
    congress: uid("form", 1),
    congressSponsor: uid("form", 2),
    pastDays: uid("form", 3),
    archived: uid("form", 4),
  },
  pricing: { congress: uid("pricing", 1), pastDays: uid("pricing", 2) },
  rule: { resident: uid("rule", 1), member: uid("rule", 2), earlyBird: uid("rule", 3) },
  access: {
    plenary: uid("access", 1),
    workshop: uid("access", 2),
    dinner: uid("access", 3),
    night1: uid("access", 4),
    night2: uid("access", 5),
    retired: uid("access", 6),
    pastWorkshop: uid("access", 21),
    pastLunch: uid("access", 22),
  },
  batch: { medis: uid("batch", 1), pharmaPlus: uid("batch", 2) },
  sponsorship: {
    signupOnly: uid("sponsorship", 1),
    signupThenLinked: uid("sponsorship", 2),
    linkedGross: uid("sponsorship", 3),
    linkedPartial: uid("sponsorship", 4),
    linkedThenEdited: uid("sponsorship", 5),
    signupFull: uid("sponsorship", 6),
    cancelled: uid("sponsorship", 7),
    unused: uid("sponsorship", 8),
  },
  registration: {
    paid: uid("registration", 1),
    partial: uid("registration", 2),
    verifying: uid("registration", 3),
    signupCode: uid("registration", 4),
    signupCodeThenLinked: uid("registration", 5),
    linkedGross: uid("registration", 6),
    linkedPartial: uid("registration", 7),
    linkedThenEdited: uid("registration", 8),
    editedWithDrop: uid("registration", 9),
    signupCodeFull: uid("registration", 10),
    waived: uid("registration", 11),
    refunded: uid("registration", 12),
    speaker: uid("registration", 13),
    paidOnline: uid("registration", 14),
    duplicateCode: uid("registration", 15),
    pastPaid: uid("registration", 21),
    pastAdminPaid: uid("registration", 22),
    pastPending: uid("registration", 23),
  },
  certificate: { attendance: uid("certificate", 1), workshop: uid("certificate", 2), retired: uid("certificate", 3) },
  bookJob: {
    completed: uid("bookJob", 1),
    failed: uid("bookJob", 2),
    pending: uid("bookJob", 3),
    leaseExpired: uid("bookJob", 4),
    secondPending: uid("bookJob", 5),
  },
  emailTemplate: {
    registrationCreated: uid("emailTemplate", 1),
    paymentConfirmed: uid("emailTemplate", 2),
    manualReminder: uid("emailTemplate", 3),
    certificate: uid("emailTemplate", 4),
    abstractAck: uid("emailTemplate", 5),
    sponsorshipPartial: uid("emailTemplate", 6),
  },
  emailLog: {
    queued: uid("emailLog", 1),
    queuedRetry: uid("emailLog", 2),
    sending: uid("emailLog", 3),
    sent: uid("emailLog", 4),
    delivered: uid("emailLog", 5),
    opened: uid("emailLog", 6),
    clicked: uid("emailLog", 7),
    bounced: uid("emailLog", 8),
    dropped: uid("emailLog", 9),
    failed: uid("emailLog", 10),
    skipped: uid("emailLog", 11),
    certificate: uid("emailLog", 12),
    abstractFallback: uid("emailLog", 13),
    abstractAck: uid("emailLog", 14),
    jsonNullSnapshot: uid("emailLog", 15),
    sqlNullSnapshot: uid("emailLog", 16),
    manualQueued: uid("emailLog", 17),
  },
  abstractConfig: { congress: uid("abstractConfig", 1), pastDays: uid("abstractConfig", 2) },
  theme: {
    interventional: uid("theme", 1),
    imaging: uid("theme", 2),
    rhythm: uid("theme", 3),
    heartFailure: uid("theme", 4),
    prevention: uid("theme", 5),
    ecg: uid("theme", 21),
    holter: uid("theme", 22),
    ablation: uid("theme", 23),
  },
  abstract: {
    acceptedOral: uid("abstract", 1),
    acceptedPoster: uid("abstract", 2),
    acceptedOral2: uid("abstract", 3),
    rejected: uid("abstract", 4),
    submittedImaging: uid("abstract", 5),
    underReviewRhythm: uid("abstract", 6),
    submittedInterventional: uid("abstract", 7),
    pending: uid("abstract", 8),
    reviewComplete: uid("abstract", 9),
    sequenceEra: uid("abstract", 10),
    reopened: uid("abstract", 11),
    pastOral1: uid("abstract", 21),
    pastOral2: uid("abstract", 22),
    pastPoster: uid("abstract", 23),
    pastSubmitted: uid("abstract", 24),
    pastSubmittedEcg: uid("abstract", 25),
  },
} as const;

const ids = LEGACY_IDS;

// ============================================================================
// Insert helper
// ============================================================================

class JsonCell {
  constructor(readonly value: unknown) {}
}
class CastCell {
  constructor(
    readonly value: unknown,
    readonly type: string,
  ) {}
}
/** A JSONB value (JSON.stringify'd, so a top-level array or null stays JSON). */
const json = (value: unknown) => new JsonCell(value);
const enumArray = (values: string[], type: string) => new CastCell(values, `"${type}"[]`);

type Cell = string | number | boolean | null | string[] | JsonCell | CastCell;
type Row = Record<string, Cell>;

/** One multi-row INSERT per table; a column a row leaves out gets its DEFAULT. */
async function insertRows(client: Client, table: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const values = columns.map((column) => {
      if (!(column in row)) return "DEFAULT";
      const cell = row[column];
      if (cell instanceof JsonCell) {
        params.push(JSON.stringify(cell.value));
        return `$${params.length}::JSONB`;
      }
      if (cell instanceof CastCell) {
        params.push(cell.value);
        return `$${params.length}::${cell.type}`;
      }
      params.push(cell);
      return `$${params.length}`;
    });
    return `(${values.join(", ")})`;
  });
  const columnList = columns.map((column) => `"${column}"`).join(", ");
  try {
    await client.query(`INSERT INTO "${table}" (${columnList}) VALUES ${tuples.join(", ")}`, params);
  } catch (error) {
    throw new Error(`Seeding ${table} failed`, { cause: error });
  }
}

// ============================================================================
// Pricing: the breakdown legacy stores (pricing.service.ts calculatePrice and
// registrations.public.routes.ts:149-169 for a public signup)
// ============================================================================

interface AccessItem {
  id: string;
  name: string;
  price: number;
  companionPrice: number;
  includedInBase: boolean;
}

interface Line {
  accessId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  status?: "confirmed";
}

interface SponsorshipLine {
  code: string;
  amount: number;
  valid: boolean;
}

interface Breakdown {
  basePrice: number;
  appliedRules: { ruleId: string; ruleName: string; effect: number; reason: string }[];
  calculatedBasePrice: number;
  accessItems: Line[];
  accessTotal: number;
  subtotal: number;
  sponsorships: SponsorshipLine[];
  sponsorshipTotal: number;
  total: number;
  currency: string;
  droppedAccessItems: (Line & { reason: string })[];
}

/** pricing.service.ts calculateAccessItemsTotal: an included item charges companions only. */
function line(access: AccessItem, quantity: number, signup: boolean): Line {
  const companions = quantity > 1 ? quantity - 1 : 0;
  return {
    accessId: access.id,
    name: access.name,
    unitPrice: access.includedInBase ? access.companionPrice : access.price,
    quantity,
    subtotal: access.includedInBase
      ? access.companionPrice * companions
      : access.price + access.companionPrice * companions,
    // A public signup marks every line confirmed (registrations.public.routes.ts:160).
    ...(signup ? { status: "confirmed" as const } : {}),
  };
}

interface PricingRule {
  id: string;
  name: string;
  price: number;
}

function breakdown(options: {
  basePrice: number;
  rule?: PricingRule;
  lines: Line[];
  sponsorships?: SponsorshipLine[];
}): Breakdown {
  const calculatedBasePrice = options.rule?.price ?? options.basePrice;
  const accessTotal = options.lines.reduce((sum, item) => sum + item.subtotal, 0);
  const subtotal = calculatedBasePrice + accessTotal;
  const sponsorships = options.sponsorships ?? [];
  const sponsorshipTotal = sponsorships.filter((s) => s.valid).reduce((sum, s) => sum + s.amount, 0);
  return {
    basePrice: options.basePrice,
    appliedRules: options.rule
      ? [
          {
            ruleId: options.rule.id,
            ruleName: options.rule.name,
            effect: options.rule.price - options.basePrice,
            reason: `Base price set to ${options.rule.price}`,
          },
        ]
      : [],
    calculatedBasePrice,
    accessItems: options.lines,
    accessTotal,
    subtotal,
    sponsorships,
    sponsorshipTotal,
    // pricing.service.ts:455: the net total.
    total: Math.max(0, subtotal - sponsorshipTotal),
    currency: "TND",
    droppedAccessItems: [],
  };
}

/** registration-enrichment.ts calculateDiscountAmount. */
function discountOf(pb: Breakdown): number {
  return Math.abs(pb.appliedRules.filter((rule) => rule.effect < 0).reduce((sum, rule) => sum + rule.effect, 0));
}

// ============================================================================
// Catalog
// ============================================================================

const CONGRESS_BASE = 200;
const PAST_BASE = 100;

const RULES = {
  resident: { id: ids.rule.resident, name: "Résidents et internes", price: 120 },
  member: { id: ids.rule.member, name: "Membres STC", price: 150 },
} satisfies Record<string, PricingRule>;

const ACCESS = {
  plenary: { id: ids.access.plenary, name: "Sessions plénières", price: 0, companionPrice: 0, includedInBase: true },
  workshop: { id: ids.access.workshop, name: "Atelier échographie", price: 50, companionPrice: 0, includedInBase: false },
  dinner: { id: ids.access.dinner, name: "Dîner de gala", price: 80, companionPrice: 40, includedInBase: false },
  night1: { id: ids.access.night1, name: "Nuit du 20 novembre", price: 120, companionPrice: 0, includedInBase: false },
  night2: { id: ids.access.night2, name: "Nuit du 21 novembre", price: 120, companionPrice: 0, includedInBase: false },
  retired: { id: ids.access.retired, name: "Visite guidée", price: 30, companionPrice: 0, includedInBase: false },
  pastWorkshop: { id: ids.access.pastWorkshop, name: "Atelier ECG", price: 40, companionPrice: 0, includedInBase: false },
  pastLunch: { id: ids.access.pastLunch, name: "Déjeuner", price: 0, companionPrice: 0, includedInBase: true },
} satisfies Record<string, AccessItem>;

/** Sponsorships: code, coverage, amount (sponsorship-batch.ts; codes are SP- plus 4 of A-Z2-9 without O, I, L). */
const SPONSORSHIPS = {
  signupOnly: { code: "SP-K7M2", coversBase: true, covered: [] as string[], amount: 200 },
  signupThenLinked: { code: "SP-P4X9", coversBase: true, covered: [] as string[], amount: 200 },
  linkedGross: { code: "SP-H3N8", coversBase: true, covered: [ids.access.workshop], amount: 250 },
  linkedPartial: { code: "SP-W5R6", coversBase: false, covered: [ids.access.workshop, ids.access.night1], amount: 170 },
  linkedThenEdited: { code: "SP-T2Y4", coversBase: true, covered: [] as string[], amount: 200 },
  signupFull: { code: "SP-F9Q3", coversBase: true, covered: [] as string[], amount: 200 },
  cancelled: { code: "SP-C8D5", coversBase: true, covered: [] as string[], amount: 200 },
  unused: { code: "SP-B6V7", coversBase: false, covered: [ids.access.dinner], amount: 80 },
};

// The registration form: field conditions (legacy forms.schema.ts has no
// `in` operator for fields; pricing rules and access items use it), option
// and field translations, and settings with a translation sidecar.
const CONGRESS_FORM_SCHEMA = {
  steps: [
    {
      id: "step_identite",
      title: "Informations personnelles",
      description: "Tous les champs marqués * sont obligatoires",
      translations: { en: { title: "Personal information", description: "All fields marked * are required" } },
      fields: [
        {
          id: "firstName_7c1d",
          type: "firstName",
          label: "Prénom",
          placeholder: "Votre prénom",
          required: true,
          width: "half",
          translations: { en: { label: "First name", placeholder: "Your first name" } },
        },
        {
          id: "lastName_2b9e",
          type: "lastName",
          label: "Nom",
          placeholder: "Votre nom",
          required: true,
          width: "half",
          translations: { en: { label: "Last name" } },
        },
        { id: "email_5a3f", type: "email", label: "Email", placeholder: "votre.email@exemple.com", required: true, width: "full" },
        { id: "phone_0c4d", type: "phone", label: "Téléphone", required: true, width: "full", phoneFormat: "TN" },
        {
          id: "specialty",
          type: "dropdown",
          label: "Spécialité",
          required: true,
          searchable: true,
          options: [
            { id: "cardiologue", label: "Cardiologue", translations: { en: { label: "Cardiologist" } } },
            { id: "resident", label: "Résident", translations: { en: { label: "Resident" } } },
            { id: "interne", label: "Interne", translations: { en: { label: "Intern" } } },
            { id: "autre", label: "Autre", translations: { en: { label: "Other" } } },
          ],
          translations: { en: { label: "Specialty" }, ar: { label: "الاختصاص" } },
        },
        {
          id: "specialty_other",
          type: "text",
          label: "Précisez votre spécialité",
          conditions: [{ id: "cond_autre", fieldId: "specialty", operator: "equals", value: "autre" }],
          conditionLogic: "AND",
          conditionAction: "show",
          clearOnHide: true,
          translations: { en: { label: "Your specialty" } },
        },
        {
          id: "member",
          type: "radio",
          label: "Membre de la STC ?",
          layout: "horizontal",
          options: [
            { id: "oui", label: "Oui" },
            { id: "non", label: "Non" },
          ],
        },
        { id: "country", type: "country", label: "Pays", searchable: true },
      ],
    },
    {
      id: "step_options",
      title: "Options",
      fields: [
        {
          id: "heading_options",
          type: "heading",
          content: "Choisissez vos options",
          headingSize: "h3",
          translations: { en: { content: "Choose your options" } },
        },
        {
          id: "diet",
          type: "checkbox",
          label: "Régime alimentaire",
          options: [
            { id: "vegetarien", label: "Végétarien" },
            { id: "sans_gluten", label: "Sans gluten" },
          ],
          validation: { maxSelections: 2 },
          conditions: [
            { fieldId: "member", operator: "not_equals", value: "non" },
            { fieldId: "country", operator: "is_not_empty" },
          ],
          conditionLogic: "OR",
        },
        {
          id: "cv",
          type: "file",
          label: "CV (résidents)",
          validation: { acceptedFileTypes: ["application/pdf"], maxFileSize: 5242880 },
          conditions: [{ fieldId: "specialty", operator: "equals", value: "resident" }],
        },
      ],
    },
  ],
  settings: {
    languages: ["fr", "en"],
    accessSelectionRequired: false,
    registrationFeeLabel: "Frais d'inscription",
    translations: { en: { registrationFeeLabel: "Registration fee" } },
    // An admin-authored key the server does not know (FormSettingsSchema is loose).
    isFree: false,
  },
};

/** forms.service.ts createDefaultSponsorSchema, as legacy stores it for a sponsor form. */
const SPONSOR_FORM_SCHEMA = {
  formType: "SPONSOR",
  sponsorSteps: [
    {
      id: "step_lab",
      title: "Informations du laboratoire",
      fields: [
        { id: "labName", type: "text", label: "Nom du laboratoire", gridColumn: "full" },
        { id: "contactName", type: "text", label: "Nom du contact", gridColumn: "half" },
        { id: "email", type: "email", label: "Email", gridColumn: "half" },
        { id: "phone", type: "phone", label: "Téléphone", gridColumn: "half" },
      ],
    },
  ],
  beneficiaryTemplate: {
    fields: [
      { id: "name", type: "text", label: "Nom complet", gridColumn: "full" },
      { id: "email", type: "email", label: "Email", gridColumn: "half" },
      { id: "phone", type: "phone", label: "Téléphone", gridColumn: "half" },
      { id: "address", type: "textarea", label: "Adresse", gridColumn: "full" },
    ],
    minCount: 1,
    maxCount: 100,
  },
  sponsorshipSettings: { sponsorshipMode: "CODE" },
};

/** forms.service.ts createDefaultSchema. */
function defaultFormSchema(suffix: string) {
  return {
    steps: [
      {
        id: `step_${suffix}`,
        title: "Informations personnelles",
        description: "Tous les champs marqués * sont obligatoires",
        fields: [
          { id: `firstName_${suffix}`, type: "firstName", label: "Prénom", placeholder: "Votre prénom", required: true, width: "half" },
          { id: `lastName_${suffix}`, type: "lastName", label: "Nom", placeholder: "Votre nom", required: true, width: "half" },
          { id: `email_${suffix}`, type: "email", label: "Email", placeholder: "votre.email@exemple.com", required: true, width: "full" },
          { id: `phone_${suffix}`, type: "phone", label: "Téléphone", placeholder: "+216 XX XXX XXX", required: true, width: "full", phoneFormat: "TN" },
          { id: `text_${suffix}`, type: "text", label: "Lieu de travail", placeholder: "Nom de votre entreprise ou établissement", required: true, width: "full" },
        ],
      },
    ],
  };
}

/** The stored pricing rules: EmbeddedPricingRuleSchema output (defaults filled), one with the `in` operator. */
const CONGRESS_RULES = [
  {
    id: ids.rule.resident,
    name: RULES.resident.name,
    description: "Tarif réduit sur justificatif",
    priority: 10,
    conditions: [{ fieldId: "specialty", operator: "in", value: ["resident", "interne"] }],
    conditionLogic: "AND",
    price: RULES.resident.price,
    active: true,
  },
  {
    id: ids.rule.member,
    name: RULES.member.name,
    priority: 5,
    conditions: [
      { fieldId: "member", operator: "equals", value: "oui" },
      { fieldId: "country", operator: "not_equals", value: "FR" },
    ],
    conditionLogic: "AND",
    price: RULES.member.price,
    active: true,
  },
  {
    id: ids.rule.earlyBird,
    name: "Early bird",
    description: null,
    priority: 0,
    conditions: [{ fieldId: "phone_0c4d", operator: "is_not_empty" }],
    conditionLogic: "OR",
    price: 180,
    active: false,
  },
];

/** CertificateZoneSchema output: every key present, defaults filled. */
function zone(id: string, variable: string, y: number, fontSize: number | null, fontWeight: "normal" | "bold") {
  return { id, x: 10, y, width: 80, height: 8, variable, fontSize, fontWeight, color: "#1F2937", textAlign: "center" };
}

/** A Tiptap document with a variable node (email.schema.ts TiptapDocumentSchema). */
function tiptap(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Bonjour " },
          { type: "variable", attrs: { id: "firstName", label: "Prénom" } },
          { type: "text", text: `, ${text}`, marks: [{ type: "bold" }] },
        ],
      },
    ],
  };
}

// ============================================================================
// Registrations
// ============================================================================

const STATUS_SETTLED = ["PAID", "SPONSORED", "WAIVED"];

interface Registrant {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  specialty: string;
}

interface RegistrationSpec {
  id: string;
  eventId: string;
  formId: string;
  person: Registrant;
  ref: string;
  pb: Breakdown;
  /** total_amount when it is not the breakdown total (an admin link keeps the stored total). */
  totalAmount?: number;
  sponsorshipAmount?: number;
  status: string;
  paidAmount?: number;
  paidAt?: string | null;
  method?: string | null;
  code?: string | null;
  labName?: string | null;
  role?: string;
  createdAt: string;
  updatedAt: string;
  lastEditedAt?: string | null;
  publicSignup: boolean;
  /** The sponsorships linked through sponsorship_usages, for legacy's PARTIAL paid count. */
  coveredAccessIds?: string[];
  accessTypeIds?: string[];
  droppedAccessIds?: string[];
  paymentReference?: string | null;
  paymentProofUrl?: string | null;
  note?: string | null;
  checkedInAt?: string | null;
  checkedInBy?: string | null;
  idempotencyKey?: number;
  formData?: Record<string, unknown>;
}

const LINK_BASE_URL = "https://inscription.example.test";

function person(firstName: string, lastName: string, specialty = "cardiologue"): Registrant {
  const slug = `${firstName}.${lastName}`.toLowerCase().normalize("NFD").replace(/[^a-z.]/g, "");
  return { firstName, lastName, email: `${slug}@example.test`, phone: "+216 98 123 456", specialty };
}

function registrationRow(spec: RegistrationSpec, editTokenSeed: number): Row {
  const p = spec.person;
  return {
    id: spec.id,
    form_id: spec.formId,
    event_id: spec.eventId,
    form_data: json(
      spec.formData ?? {
        firstName_7c1d: p.firstName,
        lastName_2b9e: p.lastName,
        email_5a3f: p.email,
        phone_0c4d: p.phone,
        specialty: p.specialty,
        member: "non",
        country: "TN",
      },
    ),
    submitted_at: spec.createdAt,
    form_schema_version: 1,
    email: p.email,
    first_name: p.firstName,
    last_name: p.lastName,
    phone: p.phone,
    reference_number: spec.ref,
    payment_status: spec.status,
    total_amount: spec.totalAmount ?? spec.pb.total,
    paid_amount: spec.paidAmount ?? 0,
    currency: "TND",
    payment_method: spec.method ?? null,
    payment_reference: spec.paymentReference ?? null,
    payment_proof_url: spec.paymentProofUrl ?? null,
    price_breakdown: json(spec.pb),
    base_amount: spec.pb.calculatedBasePrice,
    discount_amount: discountOf(spec.pb),
    access_amount: spec.pb.accessTotal,
    sponsorship_code: spec.code ?? null,
    sponsorship_amount: spec.sponsorshipAmount ?? spec.pb.sponsorshipTotal,
    lab_name: spec.labName ?? null,
    paid_at: spec.paidAt ?? null,
    created_at: spec.createdAt,
    updated_at: spec.updatedAt,
    last_edited_at: spec.lastEditedAt ?? null,
    // Admin creates store no edit token, link or idempotency key (registrations.service.ts:690-693).
    edit_token: spec.publicSignup ? token(editTokenSeed) : null,
    link_base_url: spec.publicSignup ? LINK_BASE_URL : null,
    idempotency_key: spec.publicSignup && spec.idempotencyKey ? uid("idempotency", spec.idempotencyKey) : null,
    note: spec.note ?? null,
    registration_role: spec.role ?? "PARTICIPANT",
    access_type_ids: spec.accessTypeIds ?? spec.pb.accessItems.map((item) => item.accessId),
    dropped_access_ids: spec.droppedAccessIds ?? [],
    checked_in_at: spec.checkedInAt ?? null,
    checked_in_by: spec.checkedInBy ?? null,
  };
}

/** access.service.ts paidAccessQuantities: every item when settled, the covered ones when PARTIAL. */
function legacyPaidQuantities(spec: RegistrationSpec): Map<string, number> {
  const quantities = new Map<string, number>();
  const settled = STATUS_SETTLED.includes(spec.status);
  if (!settled && spec.status !== "PARTIAL") return quantities;
  const covered = new Set(spec.coveredAccessIds ?? []);
  for (const item of spec.pb.accessItems) {
    if (settled || covered.has(item.accessId)) {
      quantities.set(item.accessId, (quantities.get(item.accessId) ?? 0) + item.quantity);
    }
  }
  return quantities;
}

function congressRegistrations(options: { duplicateSponsorshipCode: boolean }): RegistrationSpec[] {
  const congress = { eventId: ids.event.congress, formId: ids.form.congress };
  const ref = (n: number) => `36-CONGRES-CARD-${String(n).padStart(3, "0")}`;
  const signup = true;
  const s = SPONSORSHIPS;

  // A signup with a code: the breakdown applies the code's amount and the
  // registration stores the net total, the raw code and the amount, still
  // PENDING, with no usage (registrations.public.routes.ts:143-169,
  // registrations.service.ts:440-456, pricing.service.ts validateSponsorshipCodes).
  const signupCodeBreakdown = (lines: Line[], displayCode: string, amount: number) =>
    breakdown({ basePrice: CONGRESS_BASE, lines, sponsorships: [{ code: displayCode, amount, valid: true }] });

  // The admin edit of a linked registration (registrations.service.ts:1167-1225):
  // calculatePrice output (lines without status), then the linked usages
  // recomputed into the breakdown's net fields, and total_amount = net.
  const editedLinked = breakdown({
    basePrice: CONGRESS_BASE,
    lines: [line(ACCESS.plenary, 1, false), line(ACCESS.workshop, 1, false), line(ACCESS.dinner, 1, false)],
  });
  editedLinked.sponsorshipTotal = s.linkedThenEdited.amount;
  editedLinked.total = editedLinked.subtotal - s.linkedThenEdited.amount;

  // Repriced by a self-edit, then an access item deactivated: the drop keeps
  // the line under droppedAccessItems (access.service.ts:908-943).
  const droppedLine = line(ACCESS.retired, 1, false);
  const editedWithDrop = breakdown({
    basePrice: CONGRESS_BASE,
    lines: [line(ACCESS.plenary, 1, false), line(ACCESS.workshop, 1, false)],
  });
  editedWithDrop.droppedAccessItems = [{ ...droppedLine, reason: "deactivated" }];

  const specs: RegistrationSpec[] = [
    {
      // Public signup, then confirmPayment PAID (registration-payment.ts:166-180).
      id: ids.registration.paid,
      ...congress,
      person: person("Amine", "Ben Salah"),
      ref: ref(1),
      pb: breakdown({ basePrice: CONGRESS_BASE, lines: [line(ACCESS.plenary, 1, signup), line(ACCESS.workshop, 1, signup)] }),
      status: "PAID",
      paidAmount: 250,
      paidAt: "2026-06-03 14:22:05.481",
      method: "BANK_TRANSFER",
      paymentReference: "VIR-2026-0042",
      paymentProofUrl: "https://storage.example.test/payment-proofs/amine-ben-salah.pdf",
      createdAt: "2026-06-01 09:14:27.103",
      updatedAt: "2026-06-03 14:22:05.481",
      publicSignup: signup,
      idempotencyKey: 1,
    },
    {
      // A member rule and a dinner with one companion; confirmPayment PARTIAL with 100 paid.
      id: ids.registration.partial,
      ...congress,
      person: person("Salma", "Gharbi"),
      ref: ref(2),
      pb: breakdown({
        basePrice: CONGRESS_BASE,
        rule: RULES.member,
        lines: [line(ACCESS.plenary, 1, signup), line(ACCESS.dinner, 2, signup)],
      }),
      status: "PARTIAL",
      paidAmount: 100,
      method: "CASH",
      createdAt: "2026-06-02 11:02:51.770",
      updatedAt: "2026-06-05 10:45:00.012",
      publicSignup: signup,
      idempotencyKey: 2,
      formData: { firstName_7c1d: "Salma", lastName_2b9e: "Gharbi", email_5a3f: "salma.gharbi@example.test", member: "oui", country: "TN", specialty: "cardiologue", diet: ["vegetarien"] },
    },
    {
      // A resident rule; uploadPaymentProof moved it to VERIFYING (registration-payment.ts:470-485).
      id: ids.registration.verifying,
      ...congress,
      person: person("Youssef", "Jaziri", "resident"),
      ref: ref(3),
      pb: breakdown({
        basePrice: CONGRESS_BASE,
        rule: RULES.resident,
        lines: [line(ACCESS.plenary, 1, signup), line(ACCESS.workshop, 1, signup)],
      }),
      status: "VERIFYING",
      method: "BANK_TRANSFER",
      paymentProofUrl: "https://storage.example.test/payment-proofs/youssef-jaziri.jpg",
      createdAt: "2026-06-04 16:40:12.004",
      updatedAt: "2026-06-06 08:12:39.987",
      publicSignup: signup,
      idempotencyKey: 3,
    },
    {
      // A signup code typed in lower case with spaces, never linked: net total 50.
      id: ids.registration.signupCode,
      ...congress,
      person: person("Nour", "Hammami"),
      ref: ref(4),
      pb: signupCodeBreakdown([line(ACCESS.plenary, 1, signup), line(ACCESS.workshop, 1, signup)], "sp-k7m2", 200),
      status: "PENDING",
      method: "LAB_SPONSORSHIP",
      labName: "Laboratoires Médis",
      code: " sp-k7m2 ",
      createdAt: "2026-06-07 13:05:44.250",
      updatedAt: "2026-06-07 13:05:44.250",
      publicSignup: signup,
      idempotencyKey: 4,
    },
    {
      // The same shape, then an admin linked that very code: calculateApplicableAmount
      // caps the usage at the stored net total (80), the registration's
      // sponsorship amount drops from 200 to 80 and it turns SPONSORED
      // (sponsorship-math.ts:71-75, sponsorship-linking.ts:571-662). The
      // breakdown keeps the signup amount (200).
      id: ids.registration.signupCodeThenLinked,
      ...congress,
      person: person("Ines", "Trabelsi"),
      ref: ref(5),
      pb: signupCodeBreakdown([line(ACCESS.plenary, 1, signup), line(ACCESS.dinner, 1, signup)], "SP-P4X9", 200),
      totalAmount: 80,
      sponsorshipAmount: 80,
      status: "SPONSORED",
      paidAt: "2026-06-12 09:30:00.500",
      method: "LAB_SPONSORSHIP",
      labName: "Laboratoires Médis",
      code: "SP-P4X9",
      createdAt: "2026-06-08 10:11:12.131",
      updatedAt: "2026-06-12 09:30:00.500",
      publicSignup: signup,
      idempotencyKey: 5,
    },
    {
      // No code; a lab sponsorship covering the base and the workshop linked by
      // an admin: SPONSORED, total kept gross, breakdown untouched.
      id: ids.registration.linkedGross,
      ...congress,
      person: person("Karim", "Mansour"),
      ref: ref(6),
      pb: breakdown({ basePrice: CONGRESS_BASE, lines: [line(ACCESS.plenary, 1, signup), line(ACCESS.workshop, 1, signup)] }),
      sponsorshipAmount: 250,
      status: "SPONSORED",
      paidAt: "2026-06-15 15:00:00.000",
      method: "LAB_SPONSORSHIP",
      coveredAccessIds: s.linkedGross.covered,
      createdAt: "2026-06-09 08:00:01.001",
      updatedAt: "2026-06-15 15:00:00.000",
      publicSignup: signup,
      idempotencyKey: 6,
    },
    {
      // A resident with a night; a sponsorship covering the workshop and the
      // night linked by an admin: PARTIAL, covered seats counted as paid.
      id: ids.registration.linkedPartial,
      ...congress,
      person: person("Rania", "Chebbi", "resident"),
      ref: ref(7),
      pb: breakdown({
        basePrice: CONGRESS_BASE,
        rule: RULES.resident,
        lines: [line(ACCESS.plenary, 1, signup), line(ACCESS.workshop, 1, signup), line(ACCESS.night1, 1, signup)],
      }),
      sponsorshipAmount: 170,
      status: "PARTIAL",
      method: "LAB_SPONSORSHIP",
      coveredAccessIds: s.linkedPartial.covered,
      createdAt: "2026-06-10 12:34:56.789",
      updatedAt: "2026-06-16 11:11:11.111",
      publicSignup: signup,
      idempotencyKey: 7,
    },
    {
      // Linked (base sponsorship, PARTIAL), then an admin added the dinner:
      // the edit stores the net total 130 with sponsorship 200.
      id: ids.registration.linkedThenEdited,
      ...congress,
      person: person("Mehdi", "Ayari"),
      ref: ref(8),
      pb: editedLinked,
      status: "PARTIAL",
      method: "LAB_SPONSORSHIP",
      coveredAccessIds: s.linkedThenEdited.covered,
      createdAt: "2026-06-11 09:09:09.009",
      updatedAt: "2026-06-20 17:45:30.300",
      lastEditedAt: "2026-06-20 17:45:30.300",
      publicSignup: signup,
      idempotencyKey: 8,
    },
    {
      // Self-edited, then the guided tour was deactivated and dropped.
      id: ids.registration.editedWithDrop,
      ...congress,
      person: person("Olfa", "Kammoun", "autre"),
      ref: ref(9),
      pb: editedWithDrop,
      status: "PENDING",
      droppedAccessIds: [ids.access.retired],
      createdAt: "2026-06-13 18:20:00.000",
      updatedAt: "2026-07-01 07:00:00.700",
      lastEditedAt: "2026-06-25 21:03:14.159",
      publicSignup: signup,
      idempotencyKey: 9,
      formData: { firstName_7c1d: "Olfa", lastName_2b9e: "Kammoun", email_5a3f: "olfa.kammoun@example.test", specialty: "autre", specialty_other: "Médecine du sport", member: "non", country: "TN" },
    },
    {
      // A signup code covering the whole price: net total 0.
      id: ids.registration.signupCodeFull,
      ...congress,
      person: person("Hela", "Sfar"),
      ref: ref(10),
      pb: signupCodeBreakdown([line(ACCESS.plenary, 1, signup)], "sp-f9q3", 200),
      status: "PENDING",
      method: "LAB_SPONSORSHIP",
      labName: "Laboratoires Médis",
      code: "sp-f9q3",
      createdAt: "2026-06-14 10:00:00.010",
      updatedAt: "2026-06-14 10:00:00.010",
      publicSignup: signup,
      idempotencyKey: 10,
    },
    {
      // Admin create as WAIVED for an invited guest: paid_at set, nothing paid.
      id: ids.registration.waived,
      ...congress,
      person: person("Leila", "Bouzid"),
      ref: ref(11),
      pb: breakdown({ basePrice: CONGRESS_BASE, lines: [line(ACCESS.plenary, 1, false), line(ACCESS.dinner, 1, false)] }),
      status: "WAIVED",
      paidAt: "2026-06-16 09:00:00.000",
      role: "INVITED",
      createdAt: "2026-06-16 09:00:00.000",
      updatedAt: "2026-06-16 09:00:00.000",
      publicSignup: false,
    },
    {
      // Paid online, then refunded (confirmPayment REFUNDED keeps the paid amount).
      id: ids.registration.refunded,
      ...congress,
      person: person("Sami", "Riahi"),
      ref: ref(12),
      pb: breakdown({ basePrice: CONGRESS_BASE, lines: [line(ACCESS.plenary, 1, signup), line(ACCESS.workshop, 1, signup)] }),
      status: "REFUNDED",
      paidAmount: 250,
      paidAt: "2026-06-17 10:10:10.100",
      method: "ONLINE",
      paymentReference: "KNT-1B2C3D4E",
      createdAt: "2026-06-17 10:00:00.000",
      updatedAt: "2026-06-30 16:00:00.000",
      publicSignup: signup,
      idempotencyKey: 12,
    },
    {
      // Admin create of a speaker without access items.
      id: ids.registration.speaker,
      ...congress,
      person: person("Walid", "Haddad"),
      ref: ref(13),
      pb: breakdown({ basePrice: CONGRESS_BASE, lines: [] }),
      status: "PENDING",
      role: "SPEAKER",
      note: "Intervenant session 3 : prise en charge par l'organisation",
      createdAt: "2026-06-18 08:30:00.000",
      updatedAt: "2026-06-18 08:30:00.000",
      publicSignup: false,
    },
    {
      // Paid online with two nights.
      id: ids.registration.paidOnline,
      ...congress,
      person: person("Fatma", "Zouari"),
      ref: ref(14),
      pb: breakdown({
        basePrice: CONGRESS_BASE,
        rule: RULES.member,
        lines: [line(ACCESS.plenary, 1, signup), line(ACCESS.night1, 1, signup), line(ACCESS.night2, 1, signup)],
      }),
      status: "PAID",
      paidAmount: 390,
      paidAt: "2026-10-29 08:59:59.999",
      method: "ONLINE",
      paymentReference: "KNT-7F3A9C21",
      formData: { firstName_7c1d: "Fatma", lastName_2b9e: "Zouari", email_5a3f: "fatma.zouari@example.test", phone_0c4d: "+216 98 123 456", specialty: "cardiologue", member: "oui", country: "TN" },
      createdAt: "2026-10-29 08:55:02.345",
      updatedAt: "2026-10-29 08:59:59.999",
      publicSignup: signup,
      idempotencyKey: 14,
    },
  ];

  if (options.duplicateSponsorshipCode) {
    // Before 2.7 a signup never consumed the code (still PENDING), so a second
    // registrant could reuse it: 'SP-K7M2 ' normalizes to the same code.
    specs.push({
      id: ids.registration.duplicateCode,
      ...congress,
      person: person("Aziz", "Hammami"),
      ref: ref(15),
      pb: signupCodeBreakdown([line(ACCESS.plenary, 1, signup)], "SP-K7M2", 200),
      status: "PENDING",
      method: "LAB_SPONSORSHIP",
      labName: "Laboratoires Médis",
      code: "SP-K7M2 ",
      createdAt: "2026-06-19 14:00:00.000",
      updatedAt: "2026-06-19 14:00:00.000",
      publicSignup: signup,
      idempotencyKey: 15,
    });
  }
  return specs;
}

function pastDaysRegistrations(): RegistrationSpec[] {
  const past = { eventId: ids.event.pastDays, formId: ids.form.pastDays };
  const ref = (n: number) => `26-RYTHMO-2026-${String(n).padStart(3, "0")}`;
  const formData = (p: Registrant) => ({ firstName_e2: p.firstName, lastName_e2: p.lastName, email_e2: p.email, phone_e2: p.phone, text_e2: "CHU Sahloul" });
  const sami = person("Sami", "Mejri");
  const asma = person("Asma", "Kchaou");
  const hatem = person("Hatem", "Dridi");
  return [
    {
      // Paid, checked in at the event and at both access items (microsecond timestamps).
      id: ids.registration.pastPaid,
      ...past,
      person: sami,
      ref: ref(1),
      pb: breakdown({ basePrice: PAST_BASE, lines: [line(ACCESS.pastLunch, 1, true), line(ACCESS.pastWorkshop, 1, true)] }),
      status: "PAID",
      paidAmount: 140,
      paidAt: "2026-03-20 12:00:00.000",
      method: "BANK_TRANSFER",
      checkedInAt: "2026-04-10 08:31:12.123456+00",
      checkedInBy: ids.user.admin,
      createdAt: "2026-03-01 10:00:00.000",
      updatedAt: "2026-04-10 08:31:12.123",
      publicSignup: true,
      idempotencyKey: 21,
      formData: formData(sami),
    },
    {
      // Admin create as PAID: paid_at set but no paid amount (the PAID repair's section A).
      id: ids.registration.pastAdminPaid,
      ...past,
      person: asma,
      ref: ref(2),
      pb: breakdown({ basePrice: PAST_BASE, lines: [line(ACCESS.pastLunch, 1, false)] }),
      status: "PAID",
      paidAt: "2026-03-05 09:00:00.000",
      method: "CASH",
      role: "SPEAKER",
      checkedInAt: "2026-04-10 08:45:59.999999+00",
      checkedInBy: ids.user.admin,
      createdAt: "2026-03-05 09:00:00.000",
      updatedAt: "2026-04-10 08:45:59.999",
      publicSignup: false,
      formData: formData(asma),
    },
    {
      id: ids.registration.pastPending,
      ...past,
      person: hatem,
      ref: ref(3),
      pb: breakdown({ basePrice: PAST_BASE, lines: [line(ACCESS.pastLunch, 1, true)] }),
      status: "PENDING",
      createdAt: "2026-03-08 19:19:19.190",
      updatedAt: "2026-03-08 19:19:19.190",
      publicSignup: true,
      idempotencyKey: 23,
      formData: formData(hatem),
    },
  ];
}

// ============================================================================
// Seed
// ============================================================================

export interface LegacySeedOptions {
  /** Store one normalized signup code twice in an event, so 0030 stays deferred. */
  duplicateSponsorshipCode?: boolean;
  /** A second unfinished abstract-book job in the congress, which 0004's unique index refuses. */
  duplicateActiveBookJob?: boolean;
}

/**
 * Inserts the legacy rows into a database built by createLegacyPrismaDatabase
 * (before adoption). Counters (events.registered_count, event_access
 * registered_count and paid_count) are the values legacy's writers keep.
 */
export async function seedLegacyData(client: Client, options: LegacySeedOptions = {}): Promise<void> {
  const congressRegs = congressRegistrations({ duplicateSponsorshipCode: options.duplicateSponsorshipCode ?? false });
  const pastRegs = pastDaysRegistrations();
  const allRegs = [...congressRegs, ...pastRegs];

  // registered_count: every current line (create/edit reserve, drop releases);
  // paid_count: legacy's paidAccessQuantities over every registration.
  const registered = new Map<string, number>();
  const paid = new Map<string, number>();
  for (const spec of allRegs) {
    for (const item of spec.pb.accessItems) registered.set(item.accessId, (registered.get(item.accessId) ?? 0) + item.quantity);
    for (const [accessId, quantity] of legacyPaidQuantities(spec)) paid.set(accessId, (paid.get(accessId) ?? 0) + quantity);
  }
  const counts = (accessId: string) => ({ registered_count: registered.get(accessId) ?? 0, paid_count: paid.get(accessId) ?? 0 });

  await insertRows(client, "clients", [
    {
      id: ids.client.main,
      name: "Société Tunisienne de Cardiologie",
      logo: "https://storage.example.test/clients/stc/logo.png",
      primary_color: "#0E7490",
      email: "contact@stc.example.test",
      phone: "+216 71 000 000",
      created_at: "2026-01-15 09:00:00.000",
      updated_at: "2026-05-22 12:00:00.000",
    },
    {
      id: ids.client.other,
      name: "Lab Events",
      active: false,
      enabled_modules: ["pricing", "registrations", "sponsorships", "emails"],
      created_at: "2026-02-01 09:00:00.000",
      updated_at: "2026-02-01 09:00:00.000",
    },
  ]);

  await insertRows(client, "users", [
    { id: ids.user.superAdmin, email: "root@focale.example.test", name: "Super Admin", role: 0, client_id: null, created_at: "2026-01-01 00:00:00.000", updated_at: "2026-01-01 00:00:00.000" },
    { id: ids.user.admin, email: "admin@stc.example.test", name: "Admin STC", role: 1, client_id: ids.client.main, created_at: "2026-01-15 09:05:00.000", updated_at: "2026-01-15 09:05:00.000" },
    { id: ids.user.reviewer1, email: "pr.mourali@example.test", name: "Pr Mourali", role: 2, client_id: ids.client.main, created_at: "2026-05-02 10:00:00.000", updated_at: "2026-05-02 10:00:00.000" },
    { id: ids.user.reviewer2, email: "dr.kallel@example.test", name: "Dr Kallel", role: 2, client_id: ids.client.main, created_at: "2026-05-02 10:01:00.000", updated_at: "2026-05-02 10:01:00.000" },
    { id: ids.user.reviewer3, email: "dr.ouali@example.test", name: "Dr Ouali", role: 2, client_id: ids.client.main, active: false, created_at: "2026-05-03 10:00:00.000", updated_at: "2026-08-20 10:00:00.000" },
    { id: ids.user.otherAdmin, email: "admin@labevents.example.test", name: "Admin Lab Events", role: 1, client_id: ids.client.other, created_at: "2026-02-01 09:10:00.000", updated_at: "2026-02-01 09:10:00.000" },
  ]);

  await insertRows(client, "events", [
    {
      // OPEN and still ahead, so the public form read serves it.
      id: ids.event.congress,
      client_id: ids.client.main,
      name: "Congrès National de Cardiologie",
      slug: "congres-cardio-2036",
      description: "Trois jours de sessions, ateliers et posters.",
      max_capacity: 500,
      registered_count: congressRegs.length,
      start_date: "2036-11-20 08:00:00.000",
      end_date: "2036-11-22 18:00:00.000",
      location: "Hammamet",
      status: "OPEN",
      banner_url: "https://storage.example.test/events/congres/banner.jpg",
      created_at: "2026-05-20 10:00:00.000",
      updated_at: "2026-06-01 08:00:00.000",
    },
    {
      id: ids.event.pastDays,
      client_id: ids.client.main,
      name: "Journées de Rythmologie",
      slug: "rythmo-2026",
      registered_count: pastRegs.length,
      start_date: "2026-04-10 08:00:00.000",
      end_date: "2026-04-11 17:00:00.000",
      location: "Sousse",
      status: "CLOSED",
      created_at: "2026-02-10 10:00:00.000",
      updated_at: "2026-04-12 10:00:00.000",
    },
    {
      id: ids.event.archived,
      client_id: ids.client.other,
      name: "Forum Pharma 2025",
      slug: "forum.pharma_2025",
      start_date: "2025-10-01 08:00:00.000",
      end_date: "2025-10-01 18:00:00.000",
      status: "ARCHIVED",
      created_at: "2025-06-01 10:00:00.000",
      updated_at: "2025-11-01 10:00:00.000",
    },
  ]);

  await insertRows(client, "forms", [
    {
      id: ids.form.congress,
      event_id: ids.event.congress,
      name: "Inscription au congrès",
      schema: json(CONGRESS_FORM_SCHEMA),
      schema_version: 3,
      success_title: "Inscription enregistrée",
      success_message: "Vous recevrez un email de confirmation.",
      success_translations: json({ en: { successTitle: "Registration saved", successMessage: "A confirmation email is on its way." } }),
      created_at: "2026-05-20 10:05:00.000",
      updated_at: "2026-06-01 07:59:00.000",
    },
    {
      id: ids.form.congressSponsor,
      event_id: ids.event.congress,
      type: "SPONSOR",
      name: "Formulaire sponsor",
      schema: json(SPONSOR_FORM_SCHEMA),
      created_at: "2026-05-20 10:06:00.000",
      updated_at: "2026-05-20 10:06:00.000",
    },
    { id: ids.form.pastDays, event_id: ids.event.pastDays, name: "Inscription", schema: json(defaultFormSchema("e2")), created_at: "2026-02-10 10:05:00.000", updated_at: "2026-02-10 10:05:00.000" },
    { id: ids.form.archived, event_id: ids.event.archived, name: "Inscription", schema: json(defaultFormSchema("e3")), active: false, created_at: "2025-06-01 10:05:00.000", updated_at: "2025-11-01 10:00:00.000" },
  ]);

  await insertRows(client, "event_pricing", [
    {
      id: ids.pricing.congress,
      event_id: ids.event.congress,
      base_price: CONGRESS_BASE,
      rules: json(CONGRESS_RULES),
      online_payment_enabled: true,
      online_payment_url: "https://paiement.example.test/stc/congres",
      bank_name: "BIAT",
      bank_account_name: "STC",
      bank_account_number: "08 006 0123456789012 34",
      created_at: "2026-05-20 10:10:00.000",
      updated_at: "2026-05-25 16:00:00.000",
    },
    { id: ids.pricing.pastDays, event_id: ids.event.pastDays, base_price: PAST_BASE, cash_payment_enabled: true, created_at: "2026-02-10 10:10:00.000", updated_at: "2026-02-10 10:10:00.000" },
  ]);

  const accessRow = (item: AccessItem, fields: Row): Row => ({
    id: item.id,
    name: item.name,
    price: item.price,
    companion_price: item.companionPrice,
    included_in_base: item.includedInBase,
    ...counts(item.id),
    ...fields,
  });
  await insertRows(client, "event_access", [
    accessRow(ACCESS.plenary, { event_id: ids.event.congress, type: "SESSION", sort_order: 0, created_at: "2026-05-20 11:00:00.000", updated_at: "2026-05-20 11:00:00.000" }),
    accessRow(ACCESS.workshop, {
      event_id: ids.event.congress,
      type: "WORKSHOP",
      description: "Places limitées",
      location: "Salle B",
      starts_at: "2036-11-20 14:00:00.000",
      ends_at: "2036-11-20 17:00:00.000",
      max_capacity: 30,
      // Access conditions use the shared condition schema, `in` included.
      conditions: json([{ fieldId: "specialty", operator: "in", value: ["cardiologue", "resident"] }]),
      sort_order: 1,
      created_at: "2026-05-20 11:01:00.000",
      updated_at: "2026-05-21 09:00:00.000",
    }),
    accessRow(ACCESS.dinner, { event_id: ids.event.congress, type: "DINNER", allow_companion: true, starts_at: "2036-11-21 20:00:00.000", sort_order: 2, created_at: "2026-05-20 11:02:00.000", updated_at: "2026-05-20 11:02:00.000" }),
    accessRow(ACCESS.night1, { event_id: ids.event.congress, type: "ADDON", group_label: "Hébergement", sort_order: 3, available_to: "2036-11-01 00:00:00.000", created_at: "2026-05-20 11:03:00.000", updated_at: "2026-05-20 11:03:00.000" }),
    accessRow(ACCESS.night2, { event_id: ids.event.congress, type: "ADDON", group_label: "Hébergement", sort_order: 4, created_at: "2026-05-20 11:04:00.000", updated_at: "2026-05-20 11:04:00.000" }),
    accessRow(ACCESS.retired, { event_id: ids.event.congress, type: "OTHER", active: false, condition_logic: "OR", sort_order: 5, created_at: "2026-05-20 11:05:00.000", updated_at: "2026-07-01 07:00:00.700" }),
    accessRow(ACCESS.pastWorkshop, { event_id: ids.event.pastDays, type: "WORKSHOP", max_capacity: 20, sort_order: 1, created_at: "2026-02-10 11:00:00.000", updated_at: "2026-02-10 11:00:00.000" }),
    accessRow(ACCESS.pastLunch, { event_id: ids.event.pastDays, type: "OTHER", sort_order: 0, created_at: "2026-02-10 11:01:00.000", updated_at: "2026-02-10 11:01:00.000" }),
  ]);

  // The workshop and the dinner require the plenary. createEventAccess
  // connects requiredAccess (access.service.ts:294-295), which Prisma 7.2.0
  // stores as A = the prerequisite, B = the item that requires it.
  await insertRows(client, "_AccessPrerequisites", [
    { A: ids.access.plenary, B: ids.access.workshop },
    { A: ids.access.plenary, B: ids.access.dinner },
  ]);

  await insertRows(client, "sponsorship_batches", [
    {
      id: ids.batch.medis,
      event_id: ids.event.congress,
      form_id: ids.form.congressSponsor,
      lab_name: "Laboratoires Médis",
      contact_name: "Sonia Ferchichi",
      email: "sonia.ferchichi@medis.example.test",
      phone: "+216 70 000 001",
      // sponsorship-batch.ts:749-752.
      form_data: json({ sponsor: { labName: "Laboratoires Médis", contactName: "Sonia Ferchichi", email: "sonia.ferchichi@medis.example.test", phone: "+216 70 000 001" }, customFields: {} }),
      created_at: "2026-06-05 10:00:00.000",
    },
    {
      id: ids.batch.pharmaPlus,
      event_id: ids.event.congress,
      form_id: ids.form.congressSponsor,
      lab_name: "Pharma Plus",
      contact_name: "Nabil Gafsi",
      email: "nabil.gafsi@pharmaplus.example.test",
      form_data: json({ sponsor: { labName: "Pharma Plus", contactName: "Nabil Gafsi", email: "nabil.gafsi@pharmaplus.example.test" }, customFields: { budget: "2026-Q2" } }),
      created_at: "2026-06-06 10:00:00.000",
    },
  ]);

  await insertRows(
    client,
    "registrations",
    allRegs.map((spec, index) => registrationRow(spec, index + 1)),
  );

  const sponsorshipRow = (
    id: string,
    sponsorship: (typeof SPONSORSHIPS)[keyof typeof SPONSORSHIPS],
    batchId: string,
    status: string,
    beneficiary: string,
    fields: Row = {},
  ): Row => ({
    id,
    batch_id: batchId,
    event_id: ids.event.congress,
    code: sponsorship.code,
    status,
    beneficiary_name: beneficiary,
    beneficiary_email: `${beneficiary.toLowerCase().replace(/[^a-z]+/g, ".")}@example.test`,
    covers_base_price: sponsorship.coversBase,
    covered_access_ids: sponsorship.covered,
    total_amount: sponsorship.amount,
    created_at: batchId === ids.batch.medis ? "2026-06-05 10:00:00.000" : "2026-06-06 10:00:00.000",
    updated_at: status === "PENDING" ? "2026-06-05 10:00:00.000" : "2026-06-12 09:30:00.500",
    ...fields,
  });
  const sp = ids.sponsorship;
  await insertRows(client, "sponsorships", [
    sponsorshipRow(sp.signupOnly, SPONSORSHIPS.signupOnly, ids.batch.medis, "PENDING", "Nour Hammami", { beneficiary_phone: "+216 98 123 456" }),
    sponsorshipRow(sp.signupThenLinked, SPONSORSHIPS.signupThenLinked, ids.batch.medis, "USED", "Ines Trabelsi"),
    // LINKED_ACCOUNT mode: the batch named the registration it pays for.
    sponsorshipRow(sp.linkedGross, SPONSORSHIPS.linkedGross, ids.batch.pharmaPlus, "USED", "Karim Mansour", { target_registration_id: ids.registration.linkedGross }),
    sponsorshipRow(sp.linkedPartial, SPONSORSHIPS.linkedPartial, ids.batch.pharmaPlus, "USED", "Rania Chebbi", { beneficiary_address: "12 rue de Marseille, Tunis" }),
    sponsorshipRow(sp.linkedThenEdited, SPONSORSHIPS.linkedThenEdited, ids.batch.medis, "USED", "Mehdi Ayari"),
    sponsorshipRow(sp.signupFull, SPONSORSHIPS.signupFull, ids.batch.medis, "PENDING", "Hela Sfar"),
    sponsorshipRow(sp.cancelled, SPONSORSHIPS.cancelled, ids.batch.medis, "CANCELLED", "Anis Bouaziz"),
    sponsorshipRow(sp.unused, SPONSORSHIPS.unused, ids.batch.pharmaPlus, "PENDING", "Marwa Jlassi"),
  ]);

  // sponsorship-linking.ts:599-606: the usage holds calculateApplicableAmount.
  await insertRows(client, "sponsorship_usages", [
    { id: uid("usage", 2), sponsorship_id: sp.signupThenLinked, registration_id: ids.registration.signupCodeThenLinked, amount_applied: 80, applied_at: "2026-06-12 09:30:00.500", applied_by: ids.user.admin },
    { id: uid("usage", 3), sponsorship_id: sp.linkedGross, registration_id: ids.registration.linkedGross, amount_applied: 250, applied_at: "2026-06-15 15:00:00.000", applied_by: ids.user.admin },
    { id: uid("usage", 4), sponsorship_id: sp.linkedPartial, registration_id: ids.registration.linkedPartial, amount_applied: 170, applied_at: "2026-06-16 11:11:11.111", applied_by: ids.user.admin },
    { id: uid("usage", 5), sponsorship_id: sp.linkedThenEdited, registration_id: ids.registration.linkedThenEdited, amount_applied: 200, applied_at: "2026-06-14 08:00:00.000", applied_by: ids.user.admin },
  ]);

  await insertRows(client, "payment_transaction", [
    { id: uid("transaction", 1), registration_id: ids.registration.paid, type: "PAYMENT", amount: 250, method: "BANK_TRANSFER", reference: "VIR-2026-0042", performed_by: ids.user.admin, created_at: "2026-06-03 14:22:05.481" },
    { id: uid("transaction", 2), registration_id: ids.registration.partial, type: "PAYMENT", amount: 100, method: "CASH", note: "Acompte sur place", performed_by: ids.user.admin, created_at: "2026-06-05 10:45:00.012" },
    { id: uid("transaction", 3), registration_id: ids.registration.refunded, type: "PAYMENT", amount: 250, method: "ONLINE", reference: "KNT-1B2C3D4E", created_at: "2026-06-17 10:10:10.100" },
    { id: uid("transaction", 4), registration_id: ids.registration.refunded, type: "REFUND", amount: 250, method: "ONLINE", note: "Annulation", performed_by: ids.user.admin, created_at: "2026-06-30 16:00:00.000" },
  ]);

  // checkin.service.ts: per-access check-ins, TIMESTAMPTZ(6) with microseconds.
  await insertRows(client, "access_check_ins", [
    { id: uid("checkIn", 1), registration_id: ids.registration.pastPaid, access_id: ids.access.pastWorkshop, checked_in_at: "2026-04-10 09:12:33.654321+00", checked_in_by: ids.user.admin },
    { id: uid("checkIn", 2), registration_id: ids.registration.pastPaid, access_id: ids.access.pastLunch, checked_in_at: "2026-04-10 12:30:00.000001+00", checked_in_by: ids.user.admin },
    { id: uid("checkIn", 3), registration_id: ids.registration.pastAdminPaid, access_id: ids.access.pastLunch, checked_in_at: "2026-04-10 12:31:45.5+00", checked_in_by: ids.user.superAdmin },
  ]);

  await insertRows(client, "certificate_templates", [
    {
      id: ids.certificate.attendance,
      event_id: ids.event.pastDays,
      name: "Attestation de présence",
      template_url: `https://storage.example.test/certificates/${ids.event.pastDays}/attestation.png`,
      template_width: 3508,
      template_height: 2480,
      zones: json([zone("z-name", "fullName", 40, null, "bold"), zone("z-event", "eventName", 55, 28, "normal"), zone("z-date", "eventDate", 70, 18, "normal")]),
      applicable_roles: enumArray([], "RegistrationRole"),
      created_at: "2026-04-01 10:00:00.000",
      updated_at: "2026-04-02 10:00:00.000",
    },
    {
      id: ids.certificate.workshop,
      event_id: ids.event.pastDays,
      name: "Atelier ECG",
      template_url: `https://storage.example.test/certificates/${ids.event.pastDays}/atelier.png`,
      template_width: 2480,
      template_height: 3508,
      zones: json([zone("z-name", "fullName", 30, 36, "bold"), { ...zone("z-access", "selectedWorkshops", 45, null, "normal"), textAlign: "left", color: "#000000" }]),
      applicable_roles: enumArray(["PARTICIPANT", "SPEAKER"], "RegistrationRole"),
      access_id: ids.access.pastWorkshop,
      created_at: "2026-04-01 10:05:00.000",
      updated_at: "2026-04-01 10:05:00.000",
    },
    { id: ids.certificate.retired, event_id: ids.event.pastDays, name: "Ancien modèle", template_url: "", template_width: 0, template_height: 0, active: false, created_at: "2026-03-01 10:00:00.000", updated_at: "2026-03-15 10:00:00.000" },
  ]);

  const et = ids.emailTemplate;
  await insertRows(client, "email_templates", [
    { id: et.registrationCreated, client_id: ids.client.main, event_id: ids.event.congress, name: "Confirmation d'inscription", subject: "Votre inscription au {{eventName}}", content: json(tiptap("votre inscription est enregistrée.")), html_content: "<p>Bonjour {{firstName}}, votre inscription est enregistrée.</p>", plain_content: "Bonjour {{firstName}}, votre inscription est enregistrée.", category: "AUTOMATIC", trigger: "REGISTRATION_CREATED", is_default: true, created_at: "2026-05-20 12:00:00.000", updated_at: "2026-05-20 12:00:00.000" },
    { id: et.paymentConfirmed, client_id: ids.client.main, event_id: null, name: "Paiement confirmé", description: "Modèle du client", subject: "Paiement reçu : {{totalAmount}}", content: json(tiptap("nous avons reçu votre paiement.")), html_content: "<p>Paiement reçu.</p>", category: "AUTOMATIC", trigger: "PAYMENT_CONFIRMED", created_at: "2026-01-20 12:00:00.000", updated_at: "2026-01-20 12:00:00.000" },
    { id: et.manualReminder, client_id: ids.client.main, event_id: ids.event.congress, name: "Rappel", subject: "Rappel : {{eventName}}", content: json(tiptap("le congrès approche.")), mjml_content: "<mjml><mj-body></mj-body></mjml>", html_content: "<p>Rappel</p>", category: "MANUAL", created_at: "2026-06-20 12:00:00.000", updated_at: "2026-06-20 12:00:00.000" },
    { id: et.certificate, client_id: ids.client.main, event_id: ids.event.pastDays, name: "Vos attestations", subject: "Vos attestations ({{certificateCount}})", content: json(tiptap("vos attestations sont jointes.")), html_content: "<p>Attestations jointes</p>", category: "AUTOMATIC", trigger: "CERTIFICATE_SENT", created_at: "2026-04-01 12:00:00.000", updated_at: "2026-04-01 12:00:00.000" },
    { id: et.abstractAck, client_id: ids.client.main, event_id: ids.event.congress, name: "Accusé de réception résumé", subject: "Résumé reçu", content: json(tiptap("votre résumé est bien reçu.")), html_content: "<p>Résumé reçu</p>", category: "AUTOMATIC", abstract_trigger: "ABSTRACT_SUBMISSION_ACK", created_at: "2026-05-22 12:00:00.000", updated_at: "2026-05-22 12:00:00.000" },
    { id: et.sponsorshipPartial, client_id: ids.client.main, event_id: ids.event.congress, name: "Prise en charge partielle", subject: "Prise en charge partielle", content: json(tiptap("une partie est prise en charge.")), html_content: "<p>Partielle</p>", category: "AUTOMATIC", trigger: "SPONSORSHIP_PARTIAL", is_active: false, created_at: "2026-06-01 12:00:00.000", updated_at: "2026-07-01 12:00:00.000" },
  ]);

  await insertRows(client, "abstract_config", [
    {
      id: ids.abstractConfig.congress,
      event_id: ids.event.congress,
      global_word_limit: 300,
      submission_start_at: "2026-05-20 00:00:00.000",
      submission_deadline: "2036-09-30 23:59:59.000",
      editing_deadline: "2036-10-05 23:59:59.000",
      editing_enabled: true,
      comments_enabled: true,
      reviewers_per_abstract: 2,
      max_themes_per_abstract: 2,
      distribute_by_theme: true,
      book_line_spacing: 1.15,
      book_order: "BY_THEME",
      additional_fields_schema: json([{ id: "conflict", type: "radio", label: "Conflit d'intérêts", required: true, options: [{ id: "oui", label: "Oui" }, { id: "non", label: "Non" }] }]),
      languages: json(["fr", "en"]),
      created_at: "2026-05-22 09:00:00.000",
      updated_at: "2026-05-30 09:00:00.000",
    },
    {
      id: ids.abstractConfig.pastDays,
      event_id: ids.event.pastDays,
      submission_mode: "STRUCTURED",
      global_word_limit: null,
      section_word_limits: json({ introduction: 100, objective: 50, methods: 150, results: 150, conclusion: null }),
      scoring_deadline: "2026-03-20 23:59:59.000",
      final_file_deadline: "2026-04-01 23:59:59.000",
      final_file_upload_enabled: true,
      comments_sent_to_author: true,
      mode_locked: true,
      book_font_family: "Times New Roman",
      book_font_size: 10,
      book_include_author_names: false,
      created_at: "2026-02-10 12:00:00.000",
      updated_at: "2026-03-01 12:00:00.000",
    },
  ]);

  // Themes. The congress has two ACTIVE themes in slot 2 (imaging, with issued
  // codes, and rhythm, older and without); the past event left every theme in
  // the default slot 0 (abstracts.config.service.ts:215), two of them coded.
  const th = ids.theme;
  const themeRow = (id: string, configId: string, label: string, sortOrder: number, createdAt: string, fields: Row = {}): Row => ({
    id,
    config_id: configId,
    label,
    sort_order: sortOrder,
    created_at: createdAt,
    updated_at: createdAt,
    ...fields,
  });
  await insertRows(client, "abstract_themes", [
    themeRow(th.interventional, ids.abstractConfig.congress, "Cardiologie interventionnelle", 1, "2026-05-22 09:10:00.000", { translations: json({ en: { label: "Interventional cardiology" } }) }),
    themeRow(th.imaging, ids.abstractConfig.congress, "Imagerie cardiaque", 2, "2026-05-22 09:12:00.000", { description: "Échographie, IRM, scanner", translations: json({ en: { label: "Cardiac imaging", description: "Echo, MRI, CT" } }) }),
    themeRow(th.rhythm, ids.abstractConfig.congress, "Rythmologie", 2, "2026-05-22 09:11:00.000"),
    themeRow(th.heartFailure, ids.abstractConfig.congress, "Insuffisance cardiaque", 2, "2026-05-22 09:13:00.000", { active: false }),
    themeRow(th.prevention, ids.abstractConfig.congress, "Prévention", 4, "2026-05-22 09:14:00.000"),
    themeRow(th.ecg, ids.abstractConfig.pastDays, "ECG", 0, "2026-02-10 12:10:00.000"),
    themeRow(th.holter, ids.abstractConfig.pastDays, "Holter", 0, "2026-02-10 12:11:00.000"),
    themeRow(th.ablation, ids.abstractConfig.pastDays, "Ablation", 0, "2026-02-10 12:12:00.000"),
  ]);

  // Abstract codes, issued by legacy's two allocators (CODE_SUFFIX OC/PC,
  // abstracts.constants.ts:9-13; code = suffix + theme sort_order + number):
  // - 2026-03-21, per theme (abstracts.admin.service.ts:110-155): ECG
  //   OC0-01 and OC0-02, Holter PC0-01.
  // - 2026-05-24 02:14 to 16:55, the global per-final-type sequence of
  //   9aca6727: seeded from the largest code number and counter of the final
  //   type in every event, then copied into the theme counter. Interventional
  //   got OC1-03 (ORAL sequence 2 -> 3); the rejected abstract got PC2-02
  //   (POSTER sequence 1 -> 2).
  // - From a4545064 on, per theme again: imaging OC2-01, PC2-03 (its counter
  //   held 2), OC2-02 and OC2-03; then OC2-03 and PC2-02 were reopened, which
  //   clears code and code_number (abstracts.admin.service.ts:668-680).
  // So the imaging ORAL counter (3) is ahead of its largest stored code (2),
  // and the POSTER sequence (2) is in no counter any more.
  await insertRows(client, "abstract_code_counters", [
    { id: uid("counter", 1), event_id: ids.event.pastDays, theme_id: th.ecg, final_type: "ORAL_COMMUNICATION", last_value: 2, created_at: "2026-03-21 10:00:00.000", updated_at: "2026-03-21 10:05:00.000" },
    { id: uid("counter", 2), event_id: ids.event.pastDays, theme_id: th.holter, final_type: "POSTER", last_value: 1, created_at: "2026-03-21 10:10:00.000", updated_at: "2026-03-21 10:10:00.000" },
    { id: uid("counter", 3), event_id: ids.event.congress, theme_id: th.interventional, final_type: "ORAL_COMMUNICATION", last_value: 3, created_at: "2026-05-24 10:00:00.000", updated_at: "2026-05-24 10:00:00.000" },
    { id: uid("counter", 4), event_id: ids.event.congress, theme_id: th.imaging, final_type: "POSTER", last_value: 3, created_at: "2026-05-24 11:00:00.000", updated_at: "2026-06-30 10:30:00.000" },
    { id: uid("counter", 5), event_id: ids.event.congress, theme_id: th.imaging, final_type: "ORAL_COMMUNICATION", last_value: 3, created_at: "2026-06-30 10:00:00.000", updated_at: "2026-07-01 10:00:00.000" },
  ]);

  // The global sequence rows 9aca6727 wrote (20260524001000_add_abstract_code_sequences).
  await insertRows(client, "abstract_code_sequences", [
    { id: uid("sequence", 1), final_type: "ORAL_COMMUNICATION", last_value: 3, created_at: "2026-05-24 10:00:00.000", updated_at: "2026-05-24 10:00:00.000" },
    { id: uid("sequence", 2), final_type: "POSTER", last_value: 2, created_at: "2026-05-24 11:00:00.000", updated_at: "2026-05-24 11:00:00.000" },
  ]);

  // enqueueAbstractBookJob (abstracts.book.service.ts:442-480) never checks
  // for an unfinished job, so a second click enqueues a second PENDING job
  // for the same event until the worker drains them (duplicateActiveBookJob).
  await insertRows(client, "abstract_book_jobs", [
    { id: uid("bookJob", 1), event_id: ids.event.congress, requested_by: ids.user.admin, status: "COMPLETED", storage_key: `abstract-books/${ids.event.congress}/${uid("bookJob", 1)}.pdf`, included_count: 4, attempt_count: 1, last_attempt_at: "2026-07-03 10:00:00.000", created_at: "2026-07-03 09:59:00.000", started_at: "2026-07-03 10:00:00.000", completed_at: "2026-07-03 10:02:30.000", updated_at: "2026-07-03 10:02:30.000" },
    { id: uid("bookJob", 2), event_id: ids.event.congress, requested_by: ids.user.admin, status: "FAILED", error_message: "Font not found: Arial Narrow", attempt_count: 3, last_attempt_at: "2026-07-04 10:20:00.000", created_at: "2026-07-04 10:00:00.000", started_at: "2026-07-04 10:00:05.000", updated_at: "2026-07-04 10:20:00.000" },
    { id: uid("bookJob", 3), event_id: ids.event.congress, requested_by: ids.user.admin, status: "PENDING", created_at: "2026-10-29 08:00:00.000", updated_at: "2026-10-29 08:00:00.000" },
    // RUNNING when 20260501000000_add_worker_job_leases ran: its lease is 'migration-unknown'.
    { id: uid("bookJob", 4), event_id: ids.event.pastDays, requested_by: ids.user.admin, status: "RUNNING", attempt_count: 1, last_attempt_at: "2026-04-30 09:00:00.000", locked_at: "2026-04-30 09:00:00.000", locked_until: "2026-04-30 10:00:00.000", locked_by: "migration-unknown", created_at: "2026-04-30 08:59:00.000", started_at: "2026-04-30 09:00:00.000", updated_at: "2026-04-30 09:00:00.000" },
    ...(options.duplicateActiveBookJob
      ? [{ id: uid("bookJob", 5), event_id: ids.event.congress, requested_by: ids.user.admin, status: "PENDING", created_at: "2026-10-29 08:00:01.250", updated_at: "2026-10-29 08:00:01.250" }]
      : []),
  ]);

  const ab = ids.abstract;
  const freeText = (title: string) => ({ mode: "FREE_TEXT", title, body: `${title}. Méthodes, résultats et conclusion en 280 mots.` });
  const structured = (title: string) => ({ mode: "STRUCTURED", title, introduction: "Contexte.", objective: "Objectif.", methods: "Étude rétrospective.", results: "Résultats.", conclusion: "Conclusion." });
  let abstractSeq = 0;
  const abstractRow = (id: string, eventId: string, author: [string, string], fields: Row): Row => {
    abstractSeq += 1;
    const email = `${author[0]}.${author[1]}`.toLowerCase().replace(/[^a-z.]/g, "");
    return {
      id,
      event_id: eventId,
      author_first_name: author[0],
      author_last_name: author[1],
      author_affiliation: "CHU La Rabta",
      author_email: `${email}@Example.test`,
      author_email_normalized: `${email}@example.test`,
      author_phone: "+216 22 333 444",
      co_authors: json([{ firstName: "Sana", lastName: "Mzoughi", affiliation: "Hôpital Charles Nicolle" }]),
      edit_token: token(1000 + abstractSeq),
      link_base_url: "https://resumes.example.test",
      ...fields,
    };
  };
  await insertRows(client, "abstracts", [
    abstractRow(ab.acceptedOral, ids.event.congress, ["Mohamed", "Ben Ali"], { requested_type: "ORAL_COMMUNICATION", content: json(freeText("Strain VG et cardiotoxicité")), code: "OC2-01", code_number: 1, status: "ACCEPTED", final_type: "ORAL_COMMUNICATION", average_score: 16.5, review_count: 2, presented_at: "2036-11-21 10:15:00.000", presented_by: ids.user.admin, final_file_key: `abstracts/${ab.acceptedOral}/final.pdf`, final_file_kind: "PDF", final_file_size: 482133, final_file_uploaded_at: "2026-07-10 10:00:00.000", registration_id: ids.registration.paid, additional_fields_data: json({ conflict: "non" }), created_at: "2026-05-26 10:00:00.000", updated_at: "2026-07-10 10:00:00.000" }),
    abstractRow(ab.acceptedPoster, ids.event.congress, ["Hiba", "Ferjani"], { requested_type: "POSTER", content: json(freeText("Imagerie et sarcoïdose")), code: "PC2-03", code_number: 3, status: "ACCEPTED", final_type: "POSTER", created_at: "2026-05-27 10:00:00.000", updated_at: "2026-06-30 10:30:00.000" }),
    abstractRow(ab.acceptedOral2, ids.event.congress, ["Tarek", "Saidi"], { requested_type: "ORAL_COMMUNICATION", content: json(freeText("IRM de stress")), code: "OC2-02", code_number: 2, status: "ACCEPTED", final_type: "ORAL_COMMUNICATION", average_score: 14.5, review_count: 2, created_at: "2026-05-28 10:00:00.000", updated_at: "2026-07-01 09:00:00.000" }),
    abstractRow(ab.rejected, ids.event.congress, ["Imen", "Bacha"], { requested_type: "POSTER", content: json(freeText("Cas clinique")), status: "REJECTED", created_at: "2026-05-22 10:00:00.000", updated_at: "2026-07-01 11:00:00.000" }),
    abstractRow(ab.submittedImaging, ids.event.congress, ["Rim", "Jemli"], { requested_type: "ORAL_COMMUNICATION", content: json(freeText("Échographie 3D")), co_authors: json([]), created_at: "2026-06-02 10:00:00.000", updated_at: "2026-06-02 10:00:00.000" }),
    abstractRow(ab.underReviewRhythm, ids.event.congress, ["Bilel", "Toumi"], { requested_type: "ORAL_COMMUNICATION", content: json(freeText("Ablation de FA")), status: "UNDER_REVIEW", created_at: "2026-06-03 10:00:00.000", updated_at: "2026-06-10 10:00:00.000" }),
    abstractRow(ab.submittedInterventional, ids.event.congress, ["Nadia", "Lahmar"], { requested_type: "POSTER", content: json(freeText("TAVI chez le sujet âgé")), created_at: "2026-06-04 10:00:00.000", updated_at: "2026-06-04 10:00:00.000" }),
    abstractRow(ab.pending, ids.event.congress, ["Omar", "Brahmi"], { requested_type: "POSTER", content: json(freeText("Prévention secondaire")), status: "PENDING", author_affiliation: null, created_at: "2026-06-05 10:00:00.000", updated_at: "2026-06-05 10:00:00.000" }),
    abstractRow(ab.reviewComplete, ids.event.congress, ["Yosra", "Dhaouadi"], { requested_type: "ORAL_COMMUNICATION", content: json(freeText("Angioplastie primaire")), status: "REVIEW_COMPLETE", average_score: 12, review_count: 2, created_at: "2026-06-06 10:00:00.000", updated_at: "2026-06-20 10:00:00.000" }),
    abstractRow(ab.sequenceEra, ids.event.congress, ["Hamza", "Nasri"], { requested_type: "ORAL_COMMUNICATION", content: json(freeText("Occlusions chroniques")), code: "OC1-03", code_number: 3, status: "ACCEPTED", final_type: "ORAL_COMMUNICATION", created_at: "2026-05-21 10:00:00.000", updated_at: "2026-05-24 10:00:00.000" }),
    abstractRow(ab.reopened, ids.event.congress, ["Emna", "Gargouri"], { requested_type: "ORAL_COMMUNICATION", content: json(freeText("Fonction diastolique (v2)")), content_version: 2, last_edited_at: "2026-07-02 09:00:00.000", status: "SUBMITTED", additional_fields_data: json({ conflict: "oui" }), created_at: "2026-05-29 10:00:00.000", updated_at: "2026-07-02 10:00:00.000" }),
    abstractRow(ab.pastOral1, ids.event.pastDays, ["Zied", "Kacem"], { requested_type: "ORAL_COMMUNICATION", content: json(structured("QT long")), code: "OC0-01", code_number: 1, status: "ACCEPTED", final_type: "ORAL_COMMUNICATION", created_at: "2026-02-15 10:00:00.000", updated_at: "2026-03-21 10:00:00.000" }),
    abstractRow(ab.pastOral2, ids.event.pastDays, ["Mariem", "Jebali"], { requested_type: "ORAL_COMMUNICATION", content: json(structured("Brugada")), code: "OC0-02", code_number: 2, status: "ACCEPTED", final_type: "ORAL_COMMUNICATION", created_at: "2026-02-16 10:00:00.000", updated_at: "2026-03-21 10:05:00.000" }),
    abstractRow(ab.pastPoster, ids.event.pastDays, ["Fares", "Hamdi"], { requested_type: "POSTER", content: json(structured("Holter 7 jours")), code: "PC0-01", code_number: 1, status: "ACCEPTED", final_type: "POSTER", created_at: "2026-02-17 10:00:00.000", updated_at: "2026-03-21 10:10:00.000" }),
    abstractRow(ab.pastSubmitted, ids.event.pastDays, ["Ahlem", "Sassi"], { requested_type: "POSTER", content: json(structured("Holter et AVC")), created_at: "2026-02-18 10:00:00.000", updated_at: "2026-02-18 10:00:00.000" }),
    // An ECG poster never decided: ECG has no POSTER counter or code, so its
    // first poster code is PC0-01, the code Holter issued in their shared slot.
    abstractRow(ab.pastSubmittedEcg, ids.event.pastDays, ["Sarra", "Mabrouk"], { requested_type: "POSTER", content: json(structured("ECG du sportif")), created_at: "2026-02-19 10:00:00.000", updated_at: "2026-02-19 10:00:00.000" }),
  ]);

  const links: [string, string][] = [
    [ab.acceptedOral, th.imaging],
    [ab.acceptedPoster, th.imaging],
    [ab.acceptedOral2, th.imaging],
    [ab.rejected, th.imaging],
    [ab.rejected, th.prevention],
    [ab.submittedImaging, th.imaging],
    [ab.underReviewRhythm, th.rhythm],
    [ab.submittedInterventional, th.interventional],
    [ab.pending, th.prevention],
    [ab.reviewComplete, th.interventional],
    [ab.sequenceEra, th.interventional],
    [ab.reopened, th.imaging],
    [ab.pastOral1, th.ecg],
    [ab.pastOral2, th.ecg],
    [ab.pastPoster, th.holter],
    [ab.pastSubmitted, th.holter],
    [ab.pastSubmittedEcg, th.ecg],
  ];
  await insertRows(
    client,
    "abstract_theme_links",
    links.map(([abstractId, themeId], index) => ({ id: uid("themeLink", index + 1), abstract_id: abstractId, theme_id: themeId })),
  );

  const u = ids.user;
  await insertRows(client, "abstract_committee_memberships", [
    { id: uid("membership", 1), user_id: u.reviewer1, event_id: ids.event.congress, created_at: "2026-05-30 10:00:00.000", updated_at: "2026-05-30 10:00:00.000" },
    { id: uid("membership", 2), user_id: u.reviewer2, event_id: ids.event.congress, created_at: "2026-05-30 10:01:00.000", updated_at: "2026-05-30 10:01:00.000" },
    { id: uid("membership", 3), user_id: u.reviewer3, event_id: ids.event.congress, active: false, created_at: "2026-05-30 10:02:00.000", updated_at: "2026-08-20 10:00:00.000" },
  ]);

  await insertRows(client, "abstract_reviewer_themes", [
    { id: uid("reviewerTheme", 1), user_id: u.reviewer1, event_id: ids.event.congress, theme_id: th.imaging, created_at: "2026-05-30 10:05:00.000", updated_at: "2026-05-30 10:05:00.000" },
    { id: uid("reviewerTheme", 2), user_id: u.reviewer1, event_id: ids.event.congress, theme_id: th.rhythm, created_at: "2026-05-30 10:05:00.000", updated_at: "2026-05-30 10:05:00.000" },
    { id: uid("reviewerTheme", 3), user_id: u.reviewer2, event_id: ids.event.congress, theme_id: th.imaging, active: false, created_at: "2026-05-30 10:06:00.000", updated_at: "2026-06-15 10:00:00.000" },
  ]);

  const review = (n: number, abstractId: string, reviewerId: string, score: number | null, scoredAt: string | null, comment: string | null = null): Row => ({
    id: uid("review", n),
    abstract_id: abstractId,
    event_id: ids.event.congress,
    reviewer_id: reviewerId,
    score,
    comment,
    scored_at: scoredAt,
    created_at: "2026-06-01 10:00:00.000",
    updated_at: scoredAt ?? "2026-06-01 10:00:00.000",
  });
  await insertRows(client, "abstract_reviews", [
    review(1, ab.acceptedOral, u.reviewer1, 16, "2026-06-20 10:00:00.000", "Travail solide."),
    review(2, ab.acceptedOral, u.reviewer2, 17, "2026-06-21 10:00:00.000"),
    review(3, ab.acceptedOral2, u.reviewer1, 14, "2026-06-22 10:00:00.000"),
    review(4, ab.acceptedOral2, u.reviewer2, 15, "2026-06-22 11:00:00.000"),
    review(5, ab.underReviewRhythm, u.reviewer1, null, null),
    review(6, ab.reviewComplete, u.reviewer1, 12, "2026-06-19 10:00:00.000"),
    review(7, ab.reviewComplete, u.reviewer2, 12.5, "2026-06-19 11:00:00.000", "Méthodologie à préciser."),
  ]);

  await insertRows(client, "abstract_revisions", [
    {
      id: uid("revision", 1),
      abstract_id: ab.reopened,
      revision_no: 1,
      snapshot: json({ content: freeText("Fonction diastolique"), coAuthors: [], themeIds: [th.imaging], additionalFieldsData: { conflict: "non" } }),
      edited_by: "AUTHOR",
      edited_ip_address: "197.0.0.1",
      content: json(freeText("Fonction diastolique")),
      created_at: "2026-07-02 09:00:00.000",
    },
  ]);

  await insertRows(client, "committee_invite_tokens", [
    { id: uid("inviteToken", 1), token_hash: token(9001), user_id: u.reviewer2, event_id: ids.event.congress, expires_at: "2026-06-07 10:00:00.000", used_at: "2026-05-31 08:00:00.000", created_at: "2026-05-30 10:01:00.000", created_by: u.admin },
    { id: uid("inviteToken", 2), token_hash: token(9002), user_id: u.reviewer3, event_id: ids.event.congress, expires_at: "2036-12-31 23:59:59.000", created_at: "2026-10-28 10:00:00.000", created_by: u.admin },
  ]);

  const r = ids.registration;
  const el = ids.emailLog;
  // email-context.ts buildEmailContext: every variable as a formatted string.
  const context = (p: Registrant, extra: Record<string, unknown> = {}) => ({
    firstName: p.firstName,
    lastName: p.lastName,
    fullName: `${p.firstName} ${p.lastName}`,
    email: p.email,
    phone: p.phone,
    totalAmount: "250 TND",
    paidAmount: "0 TND",
    amountDue: "250 TND",
    paymentStatus: "En attente",
    paymentMethod: "Virement bancaire",
    eventName: "Congrès National de Cardiologie",
    eventDate: "20 novembre 2036",
    eventLocation: "Hammamet",
    registrationNumber: "36-CONGRES-CARD-014",
    selectedAccess: "Sessions plénières, Nuit du 20 novembre",
    form_specialty: p.specialty,
    editRegistrationLink: `${LINK_BASE_URL}/edit`,
    organizerName: "Société Tunisienne de Cardiologie",
    ...extra,
  });
  const people = Object.fromEntries(allRegs.map((spec) => [spec.id, spec.person]));
  const logRow = (id: string, registrationId: string | null, fields: Row): Row => ({
    id,
    registration_id: registrationId,
    recipient_email: registrationId ? people[registrationId]!.email : "author@example.test",
    recipient_name: registrationId ? `${people[registrationId]!.firstName} ${people[registrationId]!.lastName}` : null,
    subject: "",
    ...fields,
  });
  await insertRows(client, "email_logs", [
    logRow(el.queued, r.paidOnline, { trigger: "REGISTRATION_CREATED", template_id: et.registrationCreated, status: "QUEUED", context_snapshot: json(context(people[r.paidOnline]!)), queued_at: "2026-10-29 09:00:00.000", updated_at: "2026-10-29 09:00:00.000" }),
    // A failed attempt waiting for its retry (20260501000000 backfilled next_attempt_at this way).
    logRow(el.queuedRetry, r.paid, { trigger: "PAYMENT_CONFIRMED", template_id: et.paymentConfirmed, status: "QUEUED", retry_count: 1, attempt_count: 1, last_attempt_at: "2026-10-29 08:59:00.000", next_attempt_at: "2026-10-29 09:00:00.000", error_message: "Connection timeout", context_snapshot: json(context(people[r.paid]!, { paidAmount: "250 TND", amountDue: "0 TND" })), queued_at: "2026-10-29 08:58:00.000", updated_at: "2026-10-29 08:59:00.000" }),
    // SENDING when 20260501000000 ran: a 10 minute 'migration-unknown' lease, long expired.
    logRow(el.sending, r.signupCode, { trigger: "REGISTRATION_CREATED", template_id: et.registrationCreated, status: "SENDING", attempt_count: 1, last_attempt_at: "2026-05-01 10:00:00.000", locked_at: "2026-05-01 10:00:00.000", locked_until: "2026-05-01 10:10:00.000", locked_by: "migration-unknown", context_snapshot: json(context(people[r.signupCode]!)), queued_at: "2026-04-30 09:00:00.000", updated_at: "2026-05-01 10:00:00.000" }),
    logRow(el.sent, r.paid, { trigger: "REGISTRATION_CREATED", template_id: et.registrationCreated, subject: "Votre inscription au Congrès National de Cardiologie", status: "SENT", sendgrid_message_id: "sg-0001.filter-abc", attempt_count: 1, last_attempt_at: "2026-06-01 09:14:30.000", context_snapshot: json(context(people[r.paid]!)), queued_at: "2026-06-01 09:14:27.200", updated_at: "2026-06-01 09:14:31.000", sent_at: "2026-06-01 09:14:31.000" }),
    logRow(el.delivered, r.partial, { trigger: "REGISTRATION_CREATED", template_id: et.registrationCreated, subject: "Votre inscription au Congrès National de Cardiologie", status: "DELIVERED", sendgrid_message_id: "sg-0002", attempt_count: 1, context_snapshot: json(context(people[r.partial]!)), queued_at: "2026-06-02 11:03:00.000", updated_at: "2026-06-02 11:05:00.000", sent_at: "2026-06-02 11:03:05.000", delivered_at: "2026-06-02 11:03:09.000" }),
    logRow(el.opened, r.verifying, { trigger: "REGISTRATION_CREATED", template_id: et.registrationCreated, subject: "Votre inscription", status: "OPENED", sendgrid_message_id: "sg-0003", attempt_count: 1, context_snapshot: json(context(people[r.verifying]!)), queued_at: "2026-06-04 16:40:30.000", updated_at: "2026-06-05 07:00:00.000", sent_at: "2026-06-04 16:40:35.000", delivered_at: "2026-06-04 16:40:40.000", opened_at: "2026-06-05 07:00:00.000" }),
    // Its template was deleted since (email_logs.template_id ON DELETE SET NULL).
    logRow(el.clicked, r.linkedGross, { trigger: "SPONSORSHIP_APPLIED", template_id: null, subject: "Votre prise en charge", status: "CLICKED", sendgrid_message_id: "sg-0004", attempt_count: 1, context_snapshot: json(context(people[r.linkedGross]!, { labName: "Pharma Plus", sponsorshipCode: "SP-H3N8", sponsorshipAmount: "250 TND" })), queued_at: "2026-06-15 15:00:01.000", updated_at: "2026-06-15 18:00:00.000", sent_at: "2026-06-15 15:00:05.000", delivered_at: "2026-06-15 15:00:09.000", opened_at: "2026-06-15 17:00:00.000", clicked_at: "2026-06-15 18:00:00.000" }),
    logRow(el.bounced, r.linkedPartial, { trigger: "SPONSORSHIP_PARTIAL", template_id: et.sponsorshipPartial, subject: "Prise en charge partielle", status: "BOUNCED", sendgrid_message_id: "sg-0005", error_message: "550 Mailbox unavailable", attempt_count: 1, context_snapshot: json(context(people[r.linkedPartial]!, { remainingAmount: "120 TND" })), queued_at: "2026-06-16 11:11:12.000", updated_at: "2026-06-16 11:12:00.000", sent_at: "2026-06-16 11:11:15.000", bounced_at: "2026-06-16 11:12:00.000" }),
    logRow(el.dropped, r.linkedThenEdited, { trigger: "REGISTRATION_CREATED", template_id: et.registrationCreated, subject: "Votre inscription", status: "DROPPED", sendgrid_message_id: "sg-0006", error_message: "Bounced Address", attempt_count: 1, context_snapshot: json(context(people[r.linkedThenEdited]!)), queued_at: "2026-06-11 09:09:10.000", updated_at: "2026-06-11 09:10:00.000", sent_at: "2026-06-11 09:09:12.000" }),
    logRow(el.failed, r.editedWithDrop, { trigger: "REGISTRATION_CREATED", template_id: et.registrationCreated, status: "FAILED", retry_count: 3, attempt_count: 4, last_attempt_at: "2026-06-13 18:40:00.000", error_message: "SendGrid 403 Forbidden", context_snapshot: json(context(people[r.editedWithDrop]!)), queued_at: "2026-06-13 18:20:01.000", updated_at: "2026-06-13 18:40:00.000", failed_at: "2026-06-13 18:40:00.000" }),
    logRow(el.skipped, r.signupCodeFull, { trigger: "REGISTRATION_CREATED", template_id: et.registrationCreated, status: "SKIPPED", error_message: "Template inactive", context_snapshot: json(context(people[r.signupCodeFull]!)), queued_at: "2026-06-14 10:00:01.000", updated_at: "2026-06-14 10:00:02.000" }),
    // email-queue.service.ts:485-528: the certificate templates ride in the snapshot.
    logRow(el.certificate, r.pastPaid, { trigger: "CERTIFICATE_SENT", template_id: et.certificate, subject: "Vos attestations (2)", status: "SENT", sendgrid_message_id: "sg-0007", attempt_count: 1, context_snapshot: json(context(people[r.pastPaid]!, { eventName: "Journées de Rythmologie", certificateCount: "2", certificateList: "Attestation de présence, Atelier ECG", _certificateTemplateIds: [ids.certificate.attendance, ids.certificate.workshop] })), queued_at: "2026-04-12 10:00:00.000", updated_at: "2026-04-12 10:00:10.000", sent_at: "2026-04-12 10:00:10.000" }),
    // abstracts.email-queue.ts:300-316: no template, so the subject is resolved and the body rides in the snapshot.
    logRow(el.abstractFallback, null, { recipient_email: "mohamed.benali@example.test", recipient_name: "Mohamed Ben Ali", abstract_id: ab.acceptedOral, abstract_trigger: "ABSTRACT_ACCEPTED", subject: "Votre résumé OC2-01 est accepté", status: "SENT", sendgrid_message_id: "sg-0008", attempt_count: 1, context_snapshot: json({ authorFirstName: "Mohamed", authorLastName: "Ben Ali", abstractCode: "OC2-01", eventName: "Congrès National de Cardiologie", finalType: "Communication orale", _fallbackPlainBody: "Bonjour Mohamed, votre résumé OC2-01 est accepté en communication orale." }), queued_at: "2026-07-01 10:00:00.000", updated_at: "2026-07-01 10:00:05.000", sent_at: "2026-07-01 10:00:05.000" }),
    logRow(el.abstractAck, null, { recipient_email: "rim.jemli@Example.test", recipient_name: "Rim Jemli", abstract_id: ab.submittedImaging, abstract_trigger: "ABSTRACT_SUBMISSION_ACK", template_id: et.abstractAck, subject: "Résumé reçu", status: "DELIVERED", sendgrid_message_id: "sg-0009", attempt_count: 1, context_snapshot: json({ authorFirstName: "Rim", abstractTitle: "Échographie 3D", editLink: "https://resumes.example.test/edit" }), queued_at: "2026-06-02 10:00:01.000", updated_at: "2026-06-02 10:00:20.000", sent_at: "2026-06-02 10:00:05.000", delivered_at: "2026-06-02 10:00:20.000" }),
    // queueEmail without a context writes Prisma.JsonNull: a JSON null, not SQL NULL (email-queue.service.ts:217).
    logRow(el.jsonNullSnapshot, r.signupCodeThenLinked, { trigger: "SPONSORSHIP_LINKED", subject: "Votre code est rattaché", status: "SENT", sendgrid_message_id: "sg-0010", attempt_count: 1, context_snapshot: json(null), queued_at: "2026-06-12 09:30:01.000", updated_at: "2026-06-12 09:30:06.000", sent_at: "2026-06-12 09:30:06.000" }),
    // Queued before snapshots existed: SQL NULL.
    logRow(el.sqlNullSnapshot, r.refunded, { trigger: "PAYMENT_CONFIRMED", template_id: et.paymentConfirmed, subject: "Paiement reçu : 250 TND", status: "SENT", sendgrid_message_id: "sg-0011", attempt_count: 1, queued_at: "2026-03-10 10:00:00.000", updated_at: "2026-03-10 10:00:05.000", sent_at: "2026-03-10 10:00:05.000" }),
    logRow(el.manualQueued, r.speaker, { template_id: et.manualReminder, status: "QUEUED", context_snapshot: json(context(people[r.speaker]!, { form_specialty: "cardiologue" })), queued_at: "2026-10-29 09:01:00.000", updated_at: "2026-10-29 09:01:00.000" }),
  ]);

  // core/outbox: the four legacy types and every legacy status.
  await insertRows(client, "outbox_events", [
    { id: uid("outbox", 1), type: "email.triggered", aggregate_type: "Registration", aggregate_id: r.paidOnline, client_id: ids.client.main, event_id: ids.event.congress, dedupe_key: `email:triggered:REGISTRATION_CREATED:${r.paidOnline}`, payload: json({ trigger: "REGISTRATION_CREATED", eventId: ids.event.congress, registration: { id: r.paidOnline, email: people[r.paidOnline]!.email, firstName: "Fatma", lastName: "Zouari" } }), status: "PENDING", created_at: "2026-10-29 08:55:02.400", updated_at: "2026-10-29 08:55:02.400" },
    { id: uid("outbox", 2), type: "realtime.emit", aggregate_type: "Registration", aggregate_id: r.paid, client_id: ids.client.main, event_id: ids.event.congress, payload: json({ type: "registration.paymentConfirmed", clientId: ids.client.main, eventId: ids.event.congress, payload: { id: r.paid, paymentStatus: "PAID" }, ts: 1780496525481 }), status: "PROCESSED", attempt_count: 1, last_attempt_at: "2026-06-03 14:22:06.000", created_at: "2026-06-03 14:22:05.481", updated_at: "2026-06-03 14:22:06.000", processed_at: "2026-06-03 14:22:06.000" },
    { id: uid("outbox", 3), type: "email.abstract", aggregate_type: "Abstract", aggregate_id: ab.acceptedOral2, client_id: ids.client.main, event_id: ids.event.congress, dedupe_key: `email:abstract:ABSTRACT_ACCEPTED:${ab.acceptedOral2}:${Date.parse("2026-06-22T11:00:00.000Z")}`, payload: json({ trigger: "ABSTRACT_ACCEPTED", abstractId: ab.acceptedOral2 }), status: "FAILED", attempt_count: 2, last_attempt_at: "2026-10-29 07:00:00.000", next_attempt_at: "2026-10-29 07:05:00.000", error_message: "Template render failed", created_at: "2026-10-29 06:59:00.000", updated_at: "2026-10-29 07:00:00.000" },
    { id: uid("outbox", 4), type: "email.sponsorship", aggregate_type: "SponsorshipBatch", aggregate_id: ids.batch.pharmaPlus, client_id: ids.client.main, event_id: ids.event.congress, payload: json({ trigger: "SPONSORSHIP_BATCH_SUBMITTED", eventId: ids.event.congress, input: { batchId: ids.batch.pharmaPlus, labName: "Pharma Plus" } }), status: "DEAD_LETTERED", attempt_count: 5, last_attempt_at: "2026-06-06 11:00:00.000", error_message: "Recipient missing", created_at: "2026-06-06 10:00:01.000", updated_at: "2026-06-06 11:00:00.000" },
    { id: uid("outbox", 5), type: "email.triggered", aggregate_type: "Registration", aggregate_id: r.paidOnline, client_id: ids.client.main, event_id: ids.event.congress, dedupe_key: `email:triggered:PAYMENT_CONFIRMED:${r.paidOnline}`, payload: json({ trigger: "PAYMENT_CONFIRMED", eventId: ids.event.congress, registration: { id: r.paidOnline, email: people[r.paidOnline]!.email, firstName: "Fatma", lastName: "Zouari" } }), status: "PROCESSING", attempt_count: 1, last_attempt_at: "2026-10-29 08:00:00.000", locked_at: "2026-10-29 08:00:00.000", locked_until: "2026-10-29 08:05:00.000", locked_by: "legacy:web-7f9c:4121", created_at: "2026-10-29 07:59:59.000", updated_at: "2026-10-29 08:00:00.000" },
    { id: uid("outbox", 6), type: "realtime.emit", payload: json({ type: "eventAccess.countsChanged", clientId: ids.client.main, eventId: ids.event.congress, payload: { id: ids.event.congress, accessIds: [ids.access.workshop] }, ts: 1781000000000 }), status: "SKIPPED", created_at: "2026-06-09 08:00:01.001", updated_at: "2026-06-09 08:00:02.000", processed_at: "2026-06-09 08:00:02.000" },
  ]);

  await insertRows(client, "audit_logs", [
    { id: uid("audit", 1), entity_type: "Registration", entity_id: r.paid, action: "CREATE", changes: json({ email: { old: null, new: people[r.paid]!.email }, totalAmount: { old: null, new: 250 } }), performed_by: "PUBLIC", performed_at: "2026-06-01 09:14:27.103" },
    { id: uid("audit", 2), entity_type: "Registration", entity_id: r.paid, action: "PAYMENT_CONFIRMED", changes: json({ paymentStatus: { old: "VERIFYING", new: "PAID" }, paidAmount: { old: 0, new: 250 } }), performed_by: ids.user.admin, performed_at: "2026-06-03 14:22:05.481", ip_address: "41.226.0.10", user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)" },
    { id: uid("audit", 3), entity_type: "Sponsorship", entity_id: sp.signupThenLinked, action: "LINK_TO_REGISTRATION", changes: json({ registrationId: { old: null, new: r.signupCodeThenLinked }, amountApplied: { old: 0, new: 80 }, sponsorshipAmount: { old: 200, new: 80 }, status: { old: "PENDING", new: "USED" } }), performed_by: ids.user.admin, performed_at: "2026-06-12 09:30:00.500" },
    { id: uid("audit", 4), entity_type: "Registration", entity_id: r.editedWithDrop, action: "ACCESS_DEACTIVATED", changes: json({ accessDropped: { old: ACCESS.retired.name, new: "deactivated" }, totalAmount: { old: 280, new: 250 }, priceDeducted: { old: 0, new: 30 } }), performed_at: "2026-07-01 07:00:00.700" },
    { id: uid("audit", 5), entity_type: "Abstract", entity_id: ab.acceptedOral, action: "finalize", changes: json({ status: { old: "REVIEW_COMPLETE", new: "ACCEPTED" }, code: { old: null, new: "OC2-01" } }), performed_by: ids.user.admin, performed_at: "2026-06-30 10:00:00.000" },
    { id: uid("audit", 6), entity_type: "Abstract", entity_id: ab.reopened, action: "reopen", changes: json({ status: { old: "ACCEPTED", new: "SUBMITTED" }, finalType: { old: "ORAL_COMMUNICATION", new: null }, code: { old: "OC2-03", new: null }, codeNumber: { old: 3, new: null } }), performed_by: ids.user.admin, performed_at: "2026-07-02 08:00:00.000" },
  ]);
}

/**
 * A legacy production database with seedLegacyData's rows, taken through the
 * cutover as the rollout runs it: `adopt --apply`, then `apply`. For tests
 * that read the migrated legacy rows through app code.
 */
export async function createMigratedLegacyDatabase(
  options: { label: string } & LegacySeedOptions,
): Promise<{ database: ScratchDatabase; apply: ApplyMigrationsResult }> {
  const database = await createLegacyPrismaDatabase({ label: options.label });
  try {
    await database.client.query("SET TIME ZONE 'UTC'");
    await seedLegacyData(database.client, options);
    const migrations = await loadMigrations(defaultMigrationsDirectory(), database.engine);
    const appliedBy = "legacy-data-fixture";
    const adopted = await adoptMigrations(
      database.client,
      database.engine,
      migrations,
      { writeLedger: true, appliedBy, leaseConnectionString: database.url },
      migrationAdoptionSupport,
    );
    if (adopted.errors.length > 0) throw new Error(`adopt failed: ${adopted.errors.join("; ")}`);
    const apply = await applyMigrations(database.client, migrations, { appliedBy, leaseConnectionString: database.url });
    return { database, apply };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
