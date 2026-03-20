// =============================================================================
// EMAIL VARIABLE SERVICE — re-export facade
// Backwards-compatible re-export of the split variable/context modules.
// Internal callers should prefer importing directly from:
//   - email-variable-definitions.ts  (BASE_VARIABLES, getAvailableVariables)
//   - email-context.ts               (context builders, resolveVariables, helpers)
// =============================================================================

export {
  BASE_VARIABLES,
  getAvailableVariables,
} from "./email-variable-definitions.js";

export {
  buildEmailContext,
  buildEmailContextWithAccess,
  resolveVariables,
  sanitizeForHtml,
  sanitizeUrl,
  getSampleEmailContext,
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "./email-context.js";

export type {
  BatchEmailContextInput,
  LinkedSponsorshipContextInput,
} from "./email-context.js";
