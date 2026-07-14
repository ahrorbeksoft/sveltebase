import {
  SerializableError,
  type SerializableErrorConstructor,
} from "@sveltebase/sync";

export { SerializableError } from "@sveltebase/sync";
export type { SerializableErrorConstructor } from "@sveltebase/sync";

export type AuthErrorPayload = {
  code: string;
  message: string;
};

export type AuthErrorInput = AuthErrorPayload | string;

type AuthErrorCodec = {
  deserialize(error: AuthErrorInput): SerializableError;
};

const UNKNOWN_ERROR_CODE = "UnknownError";
const UNKNOWN_ERROR_MESSAGE = "Unknown error";

/**
 * Converts an auth failure into the stable payload returned by auth routes.
 */
export function serializeAuthError(error: unknown): AuthErrorPayload {
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

function normalizeAuthError(error: AuthErrorInput): AuthErrorPayload {
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

export function createAuthErrorCodec(
  constructors: readonly SerializableErrorConstructor[] = [],
): AuthErrorCodec {
  const constructorsByCode = new Map<string, SerializableErrorConstructor>();

  for (const ErrorClass of constructors) {
    if (constructorsByCode.has(ErrorClass.code)) {
      throw new Error(`Duplicate auth error code: ${ErrorClass.code}`);
    }

    constructorsByCode.set(ErrorClass.code, ErrorClass);
  }

  return {
    deserialize(input) {
      const payload = normalizeAuthError(input);
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

export type { AuthErrorCodec };
