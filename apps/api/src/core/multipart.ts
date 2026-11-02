import type { HttpException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

// @fastify/multipart augments the request with .file(); minimal shape used here.
export type MultipartFile = {
  filename: string;
  mimetype: string;
  toBuffer(): Promise<Buffer>;
};
export type MultipartRequest = FastifyRequest & {
  file(options?: {
    limits?: { fileSize?: number };
  }): Promise<MultipartFile | undefined>;
};

export type SingleFileOptions = {
  /** The route's own "No file uploaded" error. */
  missingFile: () => HttpException;
  /** Omitted: file() is called with no options, keeping the plugin default. */
  fileSize?: number;
  /** Treat a failing file() call as a missing file instead of rethrowing it. */
  fileErrorAsMissing?: boolean;
  /**
   * Maps @fastify/multipart's RequestFileTooLargeError, which is not an
   * HttpException and would otherwise render as 500.
   */
  onTooLarge?: () => HttpException;
};

/** Reads a request's single file part into memory. */
export async function readSingleFile(
  req: MultipartRequest,
  options: SingleFileOptions,
): Promise<{ buffer: Buffer; filename: string; mimetype: string }> {
  const read =
    options.fileSize === undefined
      ? req.file()
      : req.file({ limits: { fileSize: options.fileSize } });
  const data = await (options.fileErrorAsMissing
    ? read.catch(() => null)
    : read);
  if (!data) {
    throw options.missingFile();
  }

  let buffer: Buffer;
  try {
    buffer = await data.toBuffer();
  } catch (err) {
    if (
      options.onTooLarge &&
      (err as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
    ) {
      throw options.onTooLarge();
    }
    throw err;
  }
  return { buffer, filename: data.filename, mimetype: data.mimetype };
}
