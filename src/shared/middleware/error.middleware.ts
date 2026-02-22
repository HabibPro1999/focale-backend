import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@/generated/prisma/client.js";
import { AppError } from "@shared/errors.js";
import { formatZodError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
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
      case "P2002": // Unique constraint violation
        return reply.status(409).send({
          error: "Resource already exists",
          code: ErrorCodes.CONFLICT,
          field: (error.meta?.target as string[])?.join(", "),
          requestId,
        });

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

  // Fastify schema validation error (thrown before route handler)
  if ("code" in error && error.code === "FST_ERR_VALIDATION") {
    const validation = (
      error as FastifyError & {
        validation?: { instancePath?: string; message?: string }[];
      }
    ).validation;
    const issues =
      validation?.map((v) => ({
        field: v.instancePath?.replace(/^\//, "") || "unknown",
        message: v.message || "Invalid value",
      })) ?? [];

    return reply.status(400).send({
      error: issues.length === 1 ? issues[0].message : "Validation failed",
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
