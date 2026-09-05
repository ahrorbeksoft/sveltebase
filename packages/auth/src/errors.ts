export type AuthErrorPayload = { code: string; message: string };
export type AuthErrorInput = AuthErrorPayload | string;

/** An intentionally public error which may cross the auth HTTP boundary. */
export class SerializableError extends Error {
  static readonly code: string = 'SerializableError';
  readonly code: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code ?? (new.target as typeof SerializableError).code;
  }
}

export interface SerializableErrorConstructor {
  readonly code: string;
  new (message: string): SerializableError;
}

export type AuthErrorCodec = {
  deserialize(error: AuthErrorInput): SerializableError;
};

const UNKNOWN_ERROR_CODE = 'UnknownError';
const UNKNOWN_ERROR_MESSAGE = 'Authentication request failed';

/** Only explicitly serializable errors expose their message to a client. */
export function serializeAuthError(error: unknown): AuthErrorPayload {
  return error instanceof SerializableError
    ? { code: error.code, message: error.message }
    : { code: UNKNOWN_ERROR_CODE, message: UNKNOWN_ERROR_MESSAGE };
}

function normalizeAuthError(error: AuthErrorInput): AuthErrorPayload {
  if (typeof error === 'string') {
    return {
      code: UNKNOWN_ERROR_CODE,
      message: error || UNKNOWN_ERROR_MESSAGE,
    };
  }
  return {
    code:
      typeof error?.code === 'string' && error.code
        ? error.code
        : UNKNOWN_ERROR_CODE,
    message:
      typeof error?.message === 'string' && error.message
        ? error.message
        : UNKNOWN_ERROR_MESSAGE,
  };
}

export function createAuthErrorCodec(
  constructors: readonly SerializableErrorConstructor[] = [],
): AuthErrorCodec {
  const byCode = new Map<string, SerializableErrorConstructor>();
  for (const ErrorClass of constructors) {
    if (byCode.has(ErrorClass.code)) {
      throw new Error(`Duplicate auth error code: ${ErrorClass.code}`);
    }
    byCode.set(ErrorClass.code, ErrorClass);
  }
  return {
    deserialize(input) {
      const payload = normalizeAuthError(input);
      const ErrorClass = byCode.get(payload.code);
      return ErrorClass
        ? new ErrorClass(payload.message)
        : new SerializableError(payload.message, payload.code);
    },
  };
}
