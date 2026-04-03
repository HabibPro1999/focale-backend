import { ZodError } from 'zod';
import { AppError } from './app-error.js';
import { ErrorCodes } from './error-codes.js';

export function formatZodError(error: ZodError): AppError {
  const issues = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));

  return new AppError(
      'Validation failed',
      400,
    ErrorCodes.VALIDATION_ERROR,
    { issues }
  );
}
