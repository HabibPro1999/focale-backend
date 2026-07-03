import { Injectable } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import {
  enqueueAbstractBookJob,
  listAbstractBookJobs,
  getAbstractBookJob,
  type AbstractBookJobRow,
} from "@app/db";
import { getStorageProvider } from "@app/integrations";
import { AppException } from "./app-exception";

const SIGNED_URL_TTL_SECONDS = 60 * 60;

function formatJob(job: AbstractBookJobRow, downloadUrl: string | null = null) {
  return {
    id: job.id,
    eventId: job.eventId,
    requestedBy: job.requestedBy,
    status: job.status,
    storageKey: job.storageKey,
    downloadUrl,
    errorMessage: job.errorMessage,
    includedCount: job.includedCount,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    lastAttemptAt: job.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

/** Fresh signed download URL for COMPLETED jobs only (TTL 1h, never cached). */
async function jobDownloadUrl(job: AbstractBookJobRow): Promise<string | null> {
  if (job.status !== "COMPLETED" || !job.storageKey) return null;
  return getStorageProvider().getSignedUrl(job.storageKey, SIGNED_URL_TTL_SECONDS);
}

@Injectable()
export class AbstractsBookService {
  async enqueue(eventId: string, requestedBy: string) {
    const result = await enqueueAbstractBookJob({ eventId, requestedBy });
    if (!result.ok) {
      if (result.reason === "no_config") {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          "Abstract configuration not found",
          404,
        );
      }
      throw new AppException(
        ErrorCodes.INVALID_STATUS_TRANSITION,
        "Abstract Book can only be generated after all abstracts are finalized.",
        409,
        { unfinishedCount: result.unfinishedCount },
      );
    }
    return formatJob(result.job);
  }

  async list(eventId: string) {
    const jobs = await listAbstractBookJobs(eventId);
    return Promise.all(
      jobs.map(async (job) => formatJob(job, await jobDownloadUrl(job))),
    );
  }

  async get(eventId: string, jobId: string) {
    const job = await getAbstractBookJob(eventId, jobId);
    if (!job) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Abstract Book job not found",
        404,
      );
    }
    return formatJob(job, await jobDownloadUrl(job));
  }
}
