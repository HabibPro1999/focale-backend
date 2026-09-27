import type { FastifyRequest } from "fastify";
import { badRequest } from "./app-exception";

/** Minimal file shape used by buffered uploads. */
export type MultipartFile = {
  filename: string;
  mimetype: string;
  toBuffer(): Promise<Buffer>;
};

export type MultipartRequest = FastifyRequest & {
  file(options?: { limits?: { fileSize?: number } }): Promise<MultipartFile | undefined>;
};

type ReadSingleFileOptions = {
  fileSize?: number;
  /** Abstract final files historically treat rejected file() reads as missing. */
  fileReadErrorsAsMissing?: boolean;
  /** Only maps buffering errors; other routes keep their raw multipart errors. */
  onTooLarge?: () => Error;
};

export async function readSingleFile(
  req: MultipartRequest,
  options: ReadSingleFileOptions = {},
): Promise<{ buffer: Buffer; filename: string; mimetype: string }> {
  const pending = options.fileSize === undefined
    ? req.file()
    : req.file({ limits: { fileSize: options.fileSize } });
  const data = await (options.fileReadErrorsAsMissing ? pending.catch(() => undefined) : pending);
  if (!data) throw badRequest("No file uploaded");

  let buffer: Buffer;
  try {
    buffer = await data.toBuffer();
  } catch (err) {
    if (options.onTooLarge && (err as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw options.onTooLarge();
    }
    throw err;
  }
  return { buffer, filename: data.filename, mimetype: data.mimetype };
}
