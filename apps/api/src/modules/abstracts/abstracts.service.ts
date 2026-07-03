import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  NON_EDITABLE_STATUSES,
  type SubmitAbstractInput,
  type EditAbstractInput,
} from "@app/contracts";
import {
  findPublicConfigData,
  findEventConfigForSubmit,
  findActiveThemeIds,
  findDuplicateAuthorEmail,
  findAbstractForToken,
  findAbstractForEdit,
  submitAbstractTxn,
  editAbstractTxn,
  type AbstractConfigRow,
} from "@app/db";
import {
  newId,
  validateFormData,
  sanitizeFormData,
  type FormSchema,
} from "@app/shared";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { generateAbstractToken, verifyAbstractToken } from "./abstracts.token";
import {
  abstractContentFields,
  abstractHtmlToText,
  sanitizeAbstractContent,
  STRUCTURED_SECTIONS,
  type AbstractContent,
} from "./abstracts.html";

// ============================================================================
// Word count helper (pure)
// ============================================================================

export function countWords(s: string): number {
  if (!s) return 0;
  return s
    .replace(/[\u00A0\u2000-\u200B\u3000]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

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

function validateMode(contentMode: string, configMode: string): void {
  if (contentMode !== configMode) {
    throw new AppException(
      ErrorCodes.ABSTRACT_MODE_MISMATCH,
      `Submission mode mismatch: expected ${configMode}, got ${contentMode}`,
      409,
    );
  }
}

function validateContentPresence(content: AbstractContent): void {
  const emptyFields = abstractContentFields(content)
    .filter((field) => abstractHtmlToText(field.value).length === 0)
    .map((field) => field.name);
  if (emptyFields.length === 0) return;
  throw new AppException(
    ErrorCodes.VALIDATION_ERROR,
    `Required abstract content is empty: ${emptyFields.join(", ")}`,
    422,
    { fields: emptyFields },
  );
}

function validateWordLimits(
  content: AbstractContent,
  config: AbstractConfigRow,
): void {
  const errors: string[] = [];

  if (content.mode === "FREE_TEXT") {
    const bodyText = abstractHtmlToText(content.body);
    if (
      config.globalWordLimit != null &&
      countWords(bodyText) > config.globalWordLimit
    ) {
      errors.push(
        `body (${countWords(bodyText)} words, limit ${config.globalWordLimit})`,
      );
    }
  } else {
    const sectionLimits =
      (config.sectionWordLimits as Record<string, number> | null) ?? {};
    let total = 0;
    for (const section of STRUCTURED_SECTIONS) {
      const wordCount = countWords(
        abstractHtmlToText(
          (content as Record<string, string>)[section] ?? "",
        ),
      );
      total += wordCount;
      const limit = sectionLimits[section];
      if (limit != null && wordCount > limit) {
        errors.push(`${section} (${wordCount} words, limit ${limit})`);
      }
    }
    if (config.globalWordLimit != null && total > config.globalWordLimit) {
      errors.push(`total (${total} words, limit ${config.globalWordLimit})`);
    }
  }

  if (errors.length > 0) {
    throw new AppException(
      ErrorCodes.ABSTRACT_WORD_LIMIT_EXCEEDED,
      `Word limit exceeded: ${errors.join(", ")}`,
      422,
      { fields: errors },
    );
  }
}

async function validateThemes(
  themeIds: string[],
  configId: string,
  maxThemesPerAbstract?: number | null,
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
  if (foundIds.length !== uniqueThemeIds.length) {
    const found = new Set(foundIds);
    const invalid = uniqueThemeIds.filter((id) => !found.has(id));
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
  // --------------------------------------------------------------------------
  // Public config
  // --------------------------------------------------------------------------
  async getPublicConfig(slug: string) {
    const data = await findPublicConfigData(slug);
    if (!data) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
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
      enabled: true,
      acceptingSubmissions: submissionOpen,
      eventId: data.eventId,
      eventName: data.eventName,
      congressName: data.eventName,
      submissionMode: config.submissionMode,
      globalWordLimit: config.globalWordLimit,
      maxThemesPerAbstract: config.maxThemesPerAbstract,
      sectionWordLimits: {
        introduction: sectionLimits.introduction ?? null,
        objective: sectionLimits.objective ?? null,
        methods: sectionLimits.methods ?? null,
        results: sectionLimits.results ?? null,
        conclusion: sectionLimits.conclusion ?? null,
      },
      themes: data.themes,
      requestedTypes: [
        { value: "ORAL_COMMUNICATION", label: "Communication orale" },
        { value: "POSTER", label: "Communication affichée" },
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
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    await assertClientModuleEnabled(found.event.clientId, "abstracts");

    const config = found.config;
    if (!config) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Abstract submissions not configured",
        404,
      );
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

    const content = sanitizeAbstractContent(body.content as AbstractContent);
    validateMode(content.mode, config.submissionMode);
    validateContentPresence(content);
    validateWordLimits(content, config);
    await validateThemes(body.themeIds, config.id, config.maxThemesPerAbstract);
    const sanitizedAdditionalFields = validateAdditionalFields(
      body.additionalFieldsData,
      config.additionalFieldsSchema,
    );

    const editToken = generateAbstractToken();
    const abstractId = newId();
    const authorEmailNormalized = normalizeAuthorEmail(body.authorEmail);
    const registrationId = body.registrationId ?? null;

    if (
      await findDuplicateAuthorEmail(found.event.id, authorEmailNormalized)
    ) {
      throw duplicateAuthorEmailError();
    }

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
    if (!abstract) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
    }
    if (!verifyAbstractToken(abstract.editToken, token)) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Invalid abstract token",
        404,
      );
    }

    const config = abstract.config;
    const now = new Date();
    const editingAllowed =
      !!config?.editingEnabled &&
      (!config.editingDeadline || now <= config.editingDeadline) &&
      !NON_EDITABLE_STATUSES.includes(abstract.status);

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
    if (!abstract) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
    }
    if (!verifyAbstractToken(abstract.editToken, token)) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Invalid abstract token",
        404,
      );
    }

    const config = abstract.config;
    if (!config) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Abstract config not found",
        404,
      );
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

    if (NON_EDITABLE_STATUSES.includes(abstract.status)) {
      throw new AppException(
        ErrorCodes.ABSTRACT_NOT_EDITABLE,
        `Abstract cannot be edited in ${abstract.status} status`,
        409,
      );
    }

    const content = sanitizeAbstractContent(body.content as AbstractContent);
    validateMode(content.mode, config.submissionMode);
    validateContentPresence(content);
    validateWordLimits(content, config);
    await validateThemes(body.themeIds, config.id, config.maxThemesPerAbstract);
    const sanitizedAdditionalFields = validateAdditionalFields(
      body.additionalFieldsData,
      config.additionalFieldsSchema,
    );

    const nextRegistrationId =
      body.registrationId ?? abstract.registrationId ?? null;
    const authorEmailNormalized = normalizeAuthorEmail(body.authorEmail);

    if (
      await findDuplicateAuthorEmail(
        abstract.eventId,
        authorEmailNormalized,
        id,
      )
    ) {
      throw duplicateAuthorEmailError();
    }

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
      throw duplicateAuthorEmailError();
    }

    return this.getAbstractByToken(id, token);
  }
}
