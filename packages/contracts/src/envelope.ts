/** HTTP response envelope. Distinct from the internal Result type. */
export type ApiSuccess<T> = {
  ok: true;
  data: T;
  requestId: string;
};

export type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
};

export type ApiEnvelope<T> = ApiSuccess<T> | ApiError;
