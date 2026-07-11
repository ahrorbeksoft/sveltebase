/**
 * Error payload sent over the sync websocket.
 *
 * The sync package intentionally transports only a stable code and message.
 * Applications may encode any additional information inside `message`.
 */
export type SyncErrorPayload = {
  code: string;
  message: string;
};

export type SyncErrorInput = SyncErrorPayload | string;

/**
 * Base class for errors that should preserve their code across sync requests.
 */
export class SerializableError extends Error {
  static readonly code = "SerializableError";
  public readonly code: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code ?? (new.target as typeof SerializableError).code;
    this.name = this.code;
  }
}

/**
 * Constructor contract used to restore a known error class in the client.
 */
export type SerializableErrorConstructor<
  TError extends SerializableError = SerializableError,
> = {
  new (message: string): TError;
  readonly code: string;
};

export type ErrorCodec = {
  serialize(error: unknown): SyncErrorPayload;
  deserialize(error: SyncErrorInput): SerializableError;
};

const UNKNOWN_ERROR_CODE = "UnknownError";
const UNKNOWN_ERROR_MESSAGE = "Unknown error";

/**
 * Converts a thrown value into the small payload understood by the sync wire
 * protocol. Non-serializable errors do not expose their stack or arbitrary
 * properties to the browser.
 */
export function serializeSyncError(error: unknown): SyncErrorPayload {
  if (error instanceof SerializableError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return {
    code: UNKNOWN_ERROR_CODE,
    message: error instanceof Error && error.message
      ? error.message
      : UNKNOWN_ERROR_MESSAGE,
  };
}

function normalizeError(error: SyncErrorInput): SyncErrorPayload {
  if (typeof error === "string") {
    return {
      code: UNKNOWN_ERROR_CODE,
      message: error,
    };
  }

  return {
    code: typeof error?.code === "string" && error.code
      ? error.code
      : UNKNOWN_ERROR_CODE,
    message: typeof error?.message === "string"
      ? error.message
      : UNKNOWN_ERROR_MESSAGE,
  };
}

/**
 * Creates an error codec that restores application error subclasses from
 * their wire code and message.
 *
 * Unknown codes are still returned as SerializableError instances, so callers
 * can always inspect `code` and `message` without requiring registration.
 */
export function createErrorCodec(
  constructors: readonly SerializableErrorConstructor[] = [],
): ErrorCodec {
  const constructorsByCode = new Map<string, SerializableErrorConstructor>();

  for (const ErrorClass of constructors) {
    if (constructorsByCode.has(ErrorClass.code)) {
      throw new Error(`Duplicate serialized error code: ${ErrorClass.code}`);
    }

    constructorsByCode.set(ErrorClass.code, ErrorClass);
  }

  return {
    serialize: serializeSyncError,

    deserialize(input) {
      const payload = normalizeError(input);
      const ErrorClass = constructorsByCode.get(payload.code);

      if (!ErrorClass) {
        return new SerializableError(payload.message, payload.code);
      }

      try {
        return new ErrorClass(payload.message);
      } catch {
        return new SerializableError(payload.message, payload.code);
      }
    },
  };
}
