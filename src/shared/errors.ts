import { ZodError } from "zod";

export const ErrorCodes = {
  // Auth (1xxx)
  UNAUTHORIZED: "AUTH_1001",
  INVALID_TOKEN: "AUTH_1002",
  TOKEN_EXPIRED: "AUTH_1003",
  FORBIDDEN: "AUTH_1004",
  MODULE_NOT_ENABLED: "AUTH_1005",

  // Validation (2xxx)
  VALIDATION_ERROR: "VAL_2001",

  // Resource (3xxx)
  NOT_FOUND: "RES_3001",
  CONFLICT: "RES_3002",
  BAD_REQUEST: "RES_3003",

  // Rate Limit (4xxx)
  RATE_LIMITED: "RATE_4001",

  // Server (5xxx)
  INTERNAL_ERROR: "SRV_5001",
  DATABASE_ERROR: "SRV_5002",

  // Pricing (6xxx)
  PRICING_NOT_FOUND: "PRC_6005",

  // Access (7xxx)
  ACCESS_NOT_FOUND: "ACC_7001",
  ACCESS_CAPACITY_EXCEEDED: "ACC_7002",
  ACCESS_CIRCULAR_DEPENDENCY: "ACC_7003",
  ACCESS_HAS_REGISTRATIONS: "ACC_7004",
  ACCESS_DATE_OUT_OF_BOUNDS: "ACC_7005",
  ACCESS_HAS_PREREQUISITES: "ACC_7006",

  // Events (8xxx)
  EVENT_HAS_REGISTRATIONS: "EVT_8000",
  EVENT_NOT_OPEN: "EVT_8001",
  EVENT_FULL: "EVT_8002",

  // Registration (9xxx)
  REGISTRATION_NOT_FOUND: "REG_9001",
  REGISTRATION_ALREADY_EXISTS: "REG_9002",
  REGISTRATION_REFUNDED: "REG_9003",
  EVENT_CAPACITY_EXCEEDED: "REG_9006",
  REGISTRATION_EDIT_FORBIDDEN: "REG_9007",
  REGISTRATION_ACCESS_REMOVAL_BLOCKED: "REG_9008",
  REGISTRATION_DELETE_BLOCKED: "REG_9009",
  REGISTRATION_VERIFYING_BLOCKED: "REG_9010",
  REGISTRATION_FULLY_SPONSORED_BLOCKED: "REG_9011",
  REGISTRATION_WAIVED_ACCESS_BLOCKED: "REG_9012",

  // Form Validation (10xxx)
  FORM_VALIDATION_ERROR: "FRM_10001",
  FORM_FIELD_REQUIRED: "FRM_10002",
  FORM_FIELD_INVALID_FORMAT: "FRM_10003",
  FORM_FIELD_INVALID_TYPE: "FRM_10004",
  FORM_FILE_TOO_LARGE: "FRM_10005",
  FORM_FILE_INVALID_TYPE: "FRM_10006",
  FORM_HAS_REGISTRATIONS: "FRM_10007",
  FORM_FIELD_REMOVAL_BLOCKED: "FRM_10008",

  // File Upload (11xxx)
  INVALID_FILE_TYPE: "FIL_11001",
  FILE_TOO_LARGE: "FIL_11002",

  // State Transitions (13xxx)
  INVALID_STATUS_TRANSITION: "STT_13001",
  INVALID_PAYMENT_TRANSITION: "STT_13002",

  // Dependencies (14xxx)
  CLIENT_HAS_DEPENDENCIES: "DEP_14001",

  // Sponsorship (15xxx)
  SPONSORSHIP_STATUS_CONFLICT: "SPO_15002",

  // Email (16xxx)
  WEBHOOK_VERIFICATION_FAILED: "EML_16002",
  TEMPLATE_HAS_QUEUED_EMAILS: "EML_16003",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public isOperational: boolean = true,
    public code?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    Error.captureStackTrace(this, this.constructor);
  }
}

export function formatZodError(error: ZodError): AppError {
  const issues = error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));

  return new AppError(
    "Validation failed",
    400,
    true,
    ErrorCodes.VALIDATION_ERROR,
    { issues },
  );
}
