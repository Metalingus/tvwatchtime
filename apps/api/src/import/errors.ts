export class ImportError extends Error {
  constructor(message: string, public code = 'IMPORT_ERROR') {
    super(message);
  }
}

export class InvalidUploadError extends ImportError {
  constructor(message: string) {
    super(message, 'INVALID_UPLOAD');
  }
}

export class UnsafeArchiveError extends ImportError {
  constructor(message: string) {
    super(message, 'UNSAFE_ARCHIVE');
  }
}

export class RateLimitedError extends ImportError {
  constructor(message: string, public retryAfterMs: number) {
    super(message, 'RATE_LIMITED');
  }
}
