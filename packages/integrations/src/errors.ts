/**
 * Framework-free error carried out of the integrations layer. Apps map this
 * onto their HTTP envelope (code/message/status preserved verbatim). This is
 * the AppError-equivalent for a package that must not depend on any framework.
 */
export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IntegrationError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
