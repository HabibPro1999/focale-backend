import { assertAbstractModuleEnabled } from "./abstracts.gates";
export { assertAbstractModuleEnabled } from "./abstracts.gates";
import { Inject, Injectable } from "@nestjs/common";
import {
  ABSTRACT_TYPE_LABELS_FR,
  ErrorCodes,
  FINAL_STATUSES,
  type SubmitAbstractInput,
  type EditAbstractInput,
} from "@app/contracts";
import {
  findPublicConfigData,
  findEventConfigForSubmit,
  findActiveThemeIds,
  findAbstractThemeIds,
  findDuplicateAuthorEmail,
  findAbstractForToken,
  findAbstractForEdit,
  findRegistrationEventId,
  submitAbstractTxn,
  editAbstractTxn,
} from "@app/db";
import {
  newId,
  validateFormData,
  sanitizeFormData,
  type FormSchema,
} from "@app/shared";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { AppException, notFound } from "../../core/app-exception";
import { CONFIG, type Config } from "../../core/config";
import { assertPublicLinkBaseUrlAllowed } from "../../core/public-link-origin";
import { generateAbstractToken, assertAbstractToken } from "./abstracts.token";
import { STRUCTURED_SECTIONS, type AbstractContent } from "./abstracts.html";
import { validateAbstractContent } from "./abstracts.content-validation";

// ============================================================================
// Author input helpers
// ============================================================================

function normalizeAuthorEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

function duplicateAuthorEmailError(): AppException {
  return new AppException(
    ErrorCodes.ABSTRACT_DUPLICATE_AUTHOR_EMAIL,
    "An abstract has already been submitted for this first-author email",
    409,
  );
}

async function assertAuthorEmailFree(
  eventId: string,
  normalized: string,
  excludeId?: string,
): Promise<void> {
  const duplicate =
    excludeId === undefined
      ? await findDuplicateAuthorEmail(eventId, normalized)
      : await findDuplicateAuthorEmail(eventId, normalized, excludeId);
  if (duplicate) throw duplicateAuthorEmailError();
}

// ============================================================================
// Client module gate (M2: token-based routes must re-check the client's
// abstracts module the same way submit/getPublicConfig already do — a
// disabled module must revoke access for existing magic-link holders too).
// ============================================================================

// ============================================================================
// registrationId validation (M4: must exist and belong to the same event —
// an unvalidated UUID otherwise links an abstract to any registration).
// ============================================================================

async function validateRegistration(
  registrationId: string | null,
  eventId: string,
): Promise<void> {
  if (registrationId == null) return;
  const regEventId = await findRegistrationEventId(registrationId);
  if (regEventId == null || regEventId !== eventId) {
    throw new AppException(
      ErrorCodes.REGISTRATION_NOT_FOUND,
      "Registration not found for this event",
      422,
      { registrationId },
    );
  }
}

function buildRevisionSnapshot(
  body: SubmitAbstractInput | EditAbstractInput,
  content: AbstractContent,
  additionalFieldsData: Record<string, unknown>,
  registrationId: string | null,
  themeIds: string[],
): Record<string, unknown> {
  return {
    authorFirstName: body.authorFirstName,
    authorLastName: body.authorLastName,
    authorAffiliation: body.authorAffiliation,
    authorEmail: body.authorEmail,
    authorPhone: body.authorPhone,
    coAuthors: body.coAuthors,
    content,
    additionalFieldsData,
    requestedType: body.requestedType,
    themeIds,
    registrationId,
  };
}

// ============================================================================
// Validation helpers
// ============================================================================

async function validateThemes(
  themeIds: string[],
  configId: string,
  maxThemesPerAbstract?: number | null,
  // M14: on edit, the abstract's currently-linked themeIds stay acceptable
  // even if the theme has since been deactivated — otherwise deactivating a
  // theme bricks edits for every author already linked to it. Submit path
  // leaves this empty, so it still validates against active themes only.
  extraAllowedThemeIds: string[] = [],
): Promise<void> {
  if (themeIds.length === 0) {
    throw new AppException(
      ErrorCodes.ABSTRACT_INVALID_THEMES,
      "At least one theme is required",
      422,
    );
  }

  const uniqueThemeIds = [...new Set(themeIds)];
  if (uniqueThemeIds.length !== themeIds.length) {
    throw new AppException(
      ErrorCodes.ABSTRACT_INVALID_THEMES,
      "Duplicate theme IDs are not allowed",
      422,
    );
  }

  if (maxThemesPerAbstract && themeIds.length > maxThemesPerAbstract) {
    throw new AppException(
      ErrorCodes.ABSTRACT_TOO_MANY_THEMES,
      `Too many themes selected: maximum ${maxThemesPerAbstract}`,
      422,
      { maxThemesPerAbstract },
    );
  }

  const foundIds = await findActiveThemeIds(uniqueThemeIds, configId);
  const allowed = new Set([...foundIds, ...extraAllowedThemeIds]);
  const invalid = uniqueThemeIds.filter((id) => !allowed.has(id));
  if (invalid.length > 0) {
    throw new AppException(
      ErrorCodes.ABSTRACT_INVALID_THEMES,
      `Invalid or inactive theme IDs: ${invalid.join(", ")}`,
      422,
      { invalidThemeIds: invalid },
    );
  }
}

function validateAdditionalFields(
  data: Record<string, unknown>,
  schemaFields: unknown,
): Record<string, unknown> {
  const fields = Array.isArray(schemaFields) ? schemaFields : [];
  if (fields.length === 0) return {};

  const formSchema: FormSchema = {
    steps: [{ id: "additional", title: "Additional", fields }],
  };

  const result = validateFormData(formSchema, data);
  if (!result.valid) {
    throw new AppException(
      ErrorCodes.ABSTRACT_ADDITIONAL_FIELDS_INVALID,
      "Additional fields validation failed",
      422,
      { fieldErrors: result.errors },
    );
  }

  return sanitizeFormData(formSchema, data);
}

@Injectable()
export class AbstractsService {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  // --------------------------------------------------------------------------
  // Public config
  // --------------------------------------------------------------------------
  async getPublicConfig(slug: string) {
    const data = await findPublicConfigData(slug);
    if (!data) {
      throw notFound("Event not found");
    }

    await assertClientModuleEnabled(data.clientId, "abstracts");

    const config = data.config;
    if (!config) {
      return { enabled: false } as const;
    }

    const now = new Date();
    const submissionOpen =
      (!config.submissionStartAt || now >= config.submissionStartAt) &&
      (!config.submissionDeadline || now <= config.submissionDeadline);

    const sectionLimits = (config.sectionWordLimits ?? {}) as Record<
      string,
      number | null
    >;

    return {
      enabled: true as const,
      acceptingSubmissions: submissionOpen,
      eventId: data.eventId,
      eventName: data.eventName,
      congressName: data.eventName,
      submissionMode: config.submissionMode,
      globalWordLimit: config.globalWordLimit,
      maxThemesPerAbstract: config.maxThemesPerAbstract,
      languages: config.languages ?? null,
      sectionWordLimits: Object.fromEntries(STRUCTURED_SECTIONS.map((key) => [key, sectionLimits[key] ?? null])) as Record<typeof STRUCTURED_SECTIONS[number], number | null>,
      themes: data.themes,
      requestedTypes: [
        {
          value: "ORAL_COMMUNICATION" as const,
          label: ABSTRACT_TYPE_LABELS_FR.ORAL_COMMUNICATION,
        },
        { value: "POSTER" as const, label: ABSTRACT_TYPE_LABELS_FR.POSTER },
      ],
      additionalFields: {
        fields: Array.isArray(config.additionalFieldsSchema)
          ? config.additionalFieldsSchema
          : [],
      },
      deadlines: {
        submissionStart: config.submissionStartAt?.toISOString() ?? null,
        submission: config.submissionDeadline?.toISOString() ?? null,
        editing: config.editingDeadline?.toISOString() ?? null,
        scoringStart: config.scoringStartAt?.toISOString() ?? null,
        finalFile: config.finalFileDeadline?.toISOString() ?? null,
      },
      editingEnabled: config.editingEnabled,
      finalFileUploadEnabled: config.finalFileUploadEnabled,
    };
  }

  // --------------------------------------------------------------------------
  // Submit
  // --------------------------------------------------------------------------
  async submitAbstract(slug: string, body: SubmitAbstractInput, ip?: string) {
    const found = await findEventConfigForSubmit(slug);
    if (!found) {
      throw notFound("Event not found");
    }
    await assertClientModuleEnabled(found.event.clientId, "abstracts");

    const config = found.config;
    if (!config) {
      throw notFound("Abstract submissions not configured");
    }

    const now = new Date();
    if (config.submissionStartAt && now < config.submissionStartAt) {
      throw new AppException(
        ErrorCodes.ABSTRACT_SUBMISSIONS_NOT_OPEN,
        "Abstract submissions are not open yet",
        409,
      );
    }
    if (config.submissionDeadline && now > config.submissionDeadline) {
      throw new AppException(
        ErrorCodes.ABSTRACT_SUBMISSIONS_CLOSED,
        "Abstract submissions are closed",
        409,
      );
    }

    const content = validateAbstractContent(body.content as AbstractContent, config);
    await validateThemes(body.themeIds, config.id, config.maxThemesPerAbstract);
    assertPublicLinkBaseUrlAllowed(
      body.linkBaseUrl,
      this.config.publicLinkAllowedOrigins,
    );
    const sanitizedAdditionalFields = validateAdditionalFields(
      body.additionalFieldsData,
      config.additionalFieldsSchema,
    );

    const editToken = generateAbstractToken();
    const abstractId = newId();
    const authorEmailNormalized = normalizeAuthorEmail(body.authorEmail);
    const registrationId = body.registrationId ?? null;
    await validateRegistration(registrationId, found.event.id);

    await assertAuthorEmailFree(found.event.id, authorEmailNormalized);

    const result = await submitAbstractTxn({
      id: abstractId,
      eventId: found.event.id,
      editToken,
      authorFirstName: body.authorFirstName,
      authorLastName: body.authorLastName,
      authorAffiliation: body.authorAffiliation,
      authorEmail: body.authorEmail,
      authorEmailNormalized,
      authorPhone: body.authorPhone,
      requestedType: body.requestedType,
      content,
      coAuthors: body.coAuthors,
      additionalFieldsData: sanitizedAdditionalFields,
      linkBaseUrl: body.linkBaseUrl,
      registrationId,
      themeIds: body.themeIds,
      revisionSnapshot: buildRevisionSnapshot(
        body,
        content,
        sanitizedAdditionalFields,
        registrationId,
        body.themeIds,
      ),
      ip,
      submissionAckDedupeKey: `email:abstract:ABSTRACT_SUBMISSION_ACK:${abstractId}`,
    });

    if (!result.ok) {
      throw duplicateAuthorEmailError();
    }

    return {
      id: abstractId,
      token: editToken,
      status: "SUBMITTED" as const,
      createdAt: result.createdAt.toISOString(),
      statusUrl: `${body.linkBaseUrl}/${slug}/abstracts/${abstractId}/${editToken}`,
    };
  }

  // --------------------------------------------------------------------------
  // Get by token
  // --------------------------------------------------------------------------
  async getAbstractByToken(id: string, token: string) {
    const abstract = await findAbstractForToken(id);
    assertAbstractToken(abstract, token);
    await assertAbstractModuleEnabled(abstract.eventId);

    const config = abstract.config;
    const now = new Date();
    // M1: PENDING is a terminal committee decision (see FINAL_STATUSES /
    // abstracts.committee.service.ts, which locks reviewers out of PENDING
    // abstracts too) — it must not stay publicly editable.
    const editingAllowed =
      !!config?.editingEnabled &&
      (!config.editingDeadline || now <= config.editingDeadline) &&
      !FINAL_STATUSES.includes(abstract.status);

    return {
      id: abstract.id,
      status: abstract.status,
      code: abstract.code,
      authorFirstName: abstract.authorFirstName,
      authorLastName: abstract.authorLastName,
      authorAffiliation: abstract.authorAffiliation,
      authorEmail: abstract.authorEmail,
      authorPhone: abstract.authorPhone,
      coAuthors: abstract.coAuthors,
      requestedType: abstract.requestedType,
      finalType: abstract.finalType,
      themes: abstract.themes,
      content: abstract.content,
      additionalFieldsData: abstract.additionalFieldsData,
      createdAt: abstract.createdAt.toISOString(),
      updatedAt: abstract.updatedAt.toISOString(),
      lastEditedAt: abstract.lastEditedAt?.toISOString() ?? null,
      editing: {
        allowed: editingAllowed,
        deadline: config?.editingDeadline?.toISOString() ?? null,
      },
      finalFile: {
        enabled: config?.finalFileUploadEnabled ?? false,
        deadline: config?.finalFileDeadline?.toISOString() ?? null,
        kind: abstract.finalFileKind,
        size: abstract.finalFileSize,
        uploadedAt: abstract.finalFileUploadedAt?.toISOString() ?? null,
        uploaded: !!abstract.finalFileKey,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Edit
  // --------------------------------------------------------------------------
  async editAbstract(
    id: string,
    token: string,
    body: EditAbstractInput,
    ip?: string,
  ) {
    const abstract = await findAbstractForEdit(id);
    assertAbstractToken(abstract, token);
    await assertAbstractModuleEnabled(abstract.eventId);

    const config = abstract.config;
    if (!config) {
      throw notFound("Abstract config not found");
    }

    if (!config.editingEnabled) {
      throw new AppException(
        ErrorCodes.ABSTRACT_EDIT_DISABLED,
        "Abstract editing is disabled",
        409,
      );
    }

    const now = new Date();
    if (config.editingDeadline && now > config.editingDeadline) {
      throw new AppException(
        ErrorCodes.ABSTRACT_EDIT_DEADLINE_PASSED,
        "Editing deadline has passed",
        409,
      );
    }

    // M1: gate on FINAL_STATUSES (adds PENDING) — same terminal-decision set
    // the committee side locks scoring on, so a PENDING-finalized abstract
    // can't stay publicly editable while reviewers are locked out of it.
    if (FINAL_STATUSES.includes(abstract.status)) {
      throw new AppException(
        ErrorCodes.ABSTRACT_NOT_EDITABLE,
        `Abstract cannot be edited in ${abstract.status} status`,
        409,
      );
    }

    const content = validateAbstractContent(body.content as AbstractContent, config);
    // M14: the abstract's own (possibly now-deactivated) themes stay valid on edit.
    const currentThemeIds = await findAbstractThemeIds(id);
    await validateThemes(
      body.themeIds,
      config.id,
      config.maxThemesPerAbstract,
      currentThemeIds,
    );
    const sanitizedAdditionalFields = validateAdditionalFields(
      body.additionalFieldsData,
      config.additionalFieldsSchema,
    );

    const nextRegistrationId =
      body.registrationId ?? abstract.registrationId ?? null;
    await validateRegistration(nextRegistrationId, abstract.eventId);
    const authorEmailNormalized = normalizeAuthorEmail(body.authorEmail);

    await assertAuthorEmailFree(abstract.eventId, authorEmailNormalized, id);

    const result = await editAbstractTxn({
      id,
      authorFirstName: body.authorFirstName,
      authorLastName: body.authorLastName,
      authorAffiliation: body.authorAffiliation,
      authorEmail: body.authorEmail,
      authorEmailNormalized,
      authorPhone: body.authorPhone,
      requestedType: body.requestedType,
      content,
      coAuthors: body.coAuthors,
      additionalFieldsData: sanitizedAdditionalFields,
      registrationId: nextRegistrationId,
      themeIds: body.themeIds,
      revisionSnapshot: buildRevisionSnapshot(
        body,
        content,
        sanitizedAdditionalFields,
        nextRegistrationId,
        body.themeIds,
      ),
      lastEditedAt: now,
      ip,
    });

    if (!result.ok) {
      if (result.reason === "not_editable") {
        // A decision committed after the status check above.
        throw new AppException(
          ErrorCodes.ABSTRACT_NOT_EDITABLE,
          "Abstract cannot be edited after a decision",
          409,
        );
      }
      throw duplicateAuthorEmailError();
    }

    return this.getAbstractByToken(id, token);
  }
}
