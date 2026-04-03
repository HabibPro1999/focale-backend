import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import createHttpError from "http-errors";
import { Prisma } from "@/generated/prisma/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { formatZodError } from "@shared/errors/zod-error-formatter.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const requestId = request.id;

  // Zod validation error
  if (error instanceof ZodError) {
    const appError = formatZodError(error);
    return reply.status(400).send({
      error: appError.message,
      code: appError.code,
      details: appError.details,
      requestId,
    });
  }

  // Prisma known request error (constraint violations, etc.)
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    logger.warn(
      { err: error, code: error.code, requestId },
      "Prisma database error",
    );

    switch (error.code) {
      case "P2002": {
        // Extract constraint fields — handle both standard Prisma and CockroachDB driver adapter formats
        const target = error.meta?.target as string[] | undefined;
        const adapterFields = (
          error.meta?.driverAdapterError as
            | { cause?: { constraint?: { fields?: string[] } } }
            | undefined
        )?.cause?.constraint?.fields;
        const fields = target ?? adapterFields ?? [];
        const fieldStr = fields.join(", ");

        // Registration email+form uniqueness → domain-specific code
        const isEmailFormConstraint =
          fields.some((f) => f === "email") &&
          fields.some((f) => f === "formId" || f === "form_id");

        if (isEmailFormConstraint) {
          return reply.status(409).send({
            error:
              "A registration with this email already exists for this form",
            code: ErrorCodes.REGISTRATION_ALREADY_EXISTS,
            field: fieldStr,
            requestId,
          });
        }

        return reply.status(409).send({
          error: "Resource already exists",
          code: ErrorCodes.CONFLICT,
          field: fieldStr,
          requestId,
        });
      }

      case "P2003": // Foreign key constraint violation
        return reply.status(400).send({
          error: "Referenced resource not found",
          code: ErrorCodes.VALIDATION_ERROR,
          requestId,
        });

      case "P2025": // Record not found (for update/delete)
        return reply.status(404).send({
          error: "Resource not found",
          code: ErrorCodes.NOT_FOUND,
          requestId,
        });

      default:
        return reply.status(500).send({
          error: "Database error",
          code: ErrorCodes.DATABASE_ERROR,
          requestId,
        });
    }
  }

  // Prisma validation error (invalid data format for database)
  if (error instanceof Prisma.PrismaClientValidationError) {
    logger.warn({ err: error, requestId }, "Prisma validation error");
    return reply.status(400).send({
      error: "Invalid data format",
      code: ErrorCodes.VALIDATION_ERROR,
      requestId,
    });
  }

  // Known operational error
  if (error instanceof AppError) {
    logger.warn({ err: error, requestId }, error.message);
    return reply.status(error.statusCode).send({
      error: error.message,
      code: error.code,
      details: error.details,
      requestId,
    });
  }

  // http-errors (e.g. app.httpErrors.notFound(), .forbidden(), etc.)
  if (error instanceof createHttpError.HttpError) {
    const statusCode = error.statusCode;
    let code: string;
    if (statusCode === 400) code = ErrorCodes.VALIDATION_ERROR;
    else if (statusCode === 401) code = ErrorCodes.INVALID_TOKEN;
    else if (statusCode === 403) code = ErrorCodes.FORBIDDEN;
    else if (statusCode === 404) code = ErrorCodes.NOT_FOUND;
    else if (statusCode === 409) code = ErrorCodes.CONFLICT;
    else if (statusCode === 429) code = ErrorCodes.RATE_LIMITED;
    else code = ErrorCodes.INTERNAL_ERROR;

    if (statusCode >= 500) {
      logger.error({ err: error, requestId }, error.message);
    }

    return reply.status(statusCode).send({
      error: error.message,
      code,
      requestId,
    });
  }

  // Fastify schema validation error (thrown before route handler)
  if ("validation" in error && error.validation) {
    const fastifyError = error as FastifyError & {
      validation: { instancePath?: string; message?: string }[];
      validationContext?: string;
    };
    const issues = fastifyError.validation.map((v) => ({
      field: v.instancePath?.replace(/^\//, "") || "unknown",
      message: v.message || "Invalid value",
    }));
    const context = fastifyError.validationContext ?? "body";

    return reply.status(400).send({
      error:
        issues.length === 1
          ? issues[0].message
          : `Validation failed in ${context}`,
      code: ErrorCodes.VALIDATION_ERROR,
      details: { issues },
      requestId,
    });
  }

  // Rate limit error
  if ("statusCode" in error && error.statusCode === 429) {
    return reply.status(429).send({
      error: "Too many requests",
      code: ErrorCodes.RATE_LIMITED,
      requestId,
    });
  }

  // Unknown error
  logger.error({ err: error, requestId }, "Unhandled error");
  return reply.status(500).send({
    error: "Internal server error",
    code: ErrorCodes.INTERNAL_ERROR,
    requestId,
  });
}
