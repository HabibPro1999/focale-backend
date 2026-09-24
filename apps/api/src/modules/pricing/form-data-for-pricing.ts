import { ErrorCodes } from "@app/contracts";
import { validateFormData } from "@app/shared";
import { AppException } from "../../core/app-exception";

export interface PrepareFormDataOptions {
  /**
   * Reject blank answers to required visible fields. `true` (default) for the
   * public quote, create and self-edit; `false` for admin create/edit.
   */
  enforceRequired?: boolean;
}

/**
 * The one pricing input. The public quote, public create/self-edit and admin
 * create/edit all price — and store — the data returned here: the answers to
 * the fields the form app shows, validated and coerced; hidden-field values
 * are dropped. So a quote for the same answers equals the charge.
 *
 * Throws 400 FORM_VALIDATION_ERROR (with `fieldErrors`) for invalid answers.
 */
export function prepareFormDataForPricing(
  formSchema: unknown,
  formData: Record<string, unknown>,
  options: PrepareFormDataOptions = {},
): Record<string, unknown> {
  const result = validateFormData(formSchema, formData, {
    enforceRequired: options.enforceRequired ?? true,
  });
  if (!result.valid || !result.data) {
    throw new AppException(
      ErrorCodes.FORM_VALIDATION_ERROR,
      "Form validation failed",
      400,
      { fieldErrors: result.errors },
    );
  }
  return result.data;
}
