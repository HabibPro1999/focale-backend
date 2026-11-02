import { z } from "zod";
import {
  NetworkingMfaVerificationSchema,
  NetworkingRecommendedProfileSchema,
} from "./networking.response-rows";

/** NetworkingMfaController.state */
export const NetworkingMfaStateResponseSchema = z.object({
  enabled: z.boolean(),
  required: z.boolean(),
  verified: z.boolean(),
});

/** NetworkingMfaController.enroll */
export const NetworkingMfaEnrollResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});

/** NetworkingMfaController.confirm */
export const NetworkingMfaConfirmResponseSchema = NetworkingMfaVerificationSchema;

/** NetworkingMfaController.verify */
export const NetworkingMfaVerifyResponseSchema = NetworkingMfaVerificationSchema;

/** NetworkingMfaController.regenerateRecoveryCodes */
export const NetworkingMfaRegenerateRecoveryCodesResponseSchema = NetworkingMfaVerificationSchema;

/** NetworkingMfaController.disable */
export const NetworkingMfaDisableResponseSchema = NetworkingMfaVerificationSchema;

/** NetworkingRecommendationsController.recommendations */
export const NetworkingRecommendationRecommendationsResponseSchema = z.object({
  items: z.array(NetworkingRecommendedProfileSchema),
  total: z.number(),
  strategy: z.string(),
  model: z.string().optional(),
});

/** NetworkingRecommendationAdminController.status */
export const NetworkingRecommendationAdminStatusResponseSchema = z.object({
  configured: z.boolean(),
  model: z.string(),
  dimensions: z.number(),
  jobs: z.array(z.object({
    status: z.string(),
    count: z.number(),
  })),
});

/** NetworkingRecommendationAdminController.reindex */
export const NetworkingRecommendationAdminReindexResponseSchema = z.object({
  queued: z.number(),
});
