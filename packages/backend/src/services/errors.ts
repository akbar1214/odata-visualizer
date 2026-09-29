import multer from 'multer';

/**
 * An error that is safe to report to the caller with its status.
 *
 * The backend distinguishes these from unexpected faults so a rejected upload
 * or an oversized body is reported as 4xx with a useful message, instead of a
 * 500 that hides the cause (or leaks a stack trace).
 */
export class ClientError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
  }
}

/** Raised when the request timed out; reported as 504. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Raised when a response body exceeds the configured cap; reported as 502. */
export class ResponseTooLargeError extends Error {
  readonly status = 502;

  constructor(message: string) {
    super(message);
    this.name = 'ResponseTooLargeError';
  }
}

interface StatusCarrier {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
}

function toStatus(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 400 && value <= 599 ? value : undefined;
}

/**
 * True when the error is the caller's fault and its message is safe to return.
 *
 * Multer and body-parser both signal with a `code` and a numeric status; a
 * `fileFilter` rejection is an ordinary `Error`, which the parse router
 * classifies itself.
 */
export function isClientError(error: unknown): error is Error & { status: number } {
  if (!(error instanceof Error)) return false;
  const candidate = error as StatusCarrier;

  const status = toStatus(candidate.status) ?? toStatus(candidate.statusCode);
  if (status !== undefined && status < 500) return true;

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
      case 'LIMIT_FILE_COUNT':
        return true;
      case 'LIMIT_UNEXPECTED_FILE':
      case 'LIMIT_FIELD_COUNT':
      case 'LIMIT_FIELD_KEY':
      case 'LIMIT_FIELD_VALUE':
      case 'LIMIT_PART_COUNT':
        return true;
      default:
        return false;
    }
  }

  // body-parser: entity.too.large, entity.parse.failed, encoding.unsupported…
  return (
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('entity.') &&
    candidate.code !== 'entity.verify.failed'
  );
}

/** The HTTP status an unexpected error should be reported as. */
export function statusForError(error: unknown): number {
  if (error instanceof TimeoutError) return 504;
  if (error instanceof ResponseTooLargeError) return 502;

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
      case 'LIMIT_FILE_COUNT':
        return 413;
      case 'LIMIT_UNEXPECTED_FILE':
      case 'LIMIT_FIELD_COUNT':
      case 'LIMIT_FIELD_KEY':
      case 'LIMIT_FIELD_VALUE':
      case 'LIMIT_PART_COUNT':
        return 400;
      default:
        return 500;
    }
  }

  const candidate = (error ?? {}) as StatusCarrier;
  if (
    candidate.name === 'TimeoutError' ||
    candidate.name === 'AbortError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 23
  ) {
    return 504;
  }

  // body-parser reports entity.too.large with no numeric status of its own.
  if (typeof candidate.code === 'string' && candidate.code === 'entity.too.large') return 413;

  const status = toStatus(candidate.status) ?? toStatus(candidate.statusCode);
  return status ?? 500;
}
