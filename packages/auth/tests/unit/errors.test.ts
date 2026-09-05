import { describe, expect, it } from 'vitest';
import {
  createAuthErrorCodec,
  serializeAuthError,
  SerializableError,
} from '../../src/errors.js';

class PublicError extends SerializableError {
  static readonly code = 'PublicError';
}

describe('auth errors', () => {
  it('only serializes deliberately public errors', () => {
    expect(serializeAuthError(new PublicError('safe'))).toEqual({
      code: 'PublicError',
      message: 'safe',
    });
    expect(serializeAuthError(new Error('secret'))).toEqual({
      code: 'UnknownError',
      message: 'Authentication request failed',
    });
  });
  it('restores registered errors and normalizes malformed payloads', () => {
    const codec = createAuthErrorCodec([PublicError]);
    expect(
      codec.deserialize({ code: 'PublicError', message: 'safe' }),
    ).toBeInstanceOf(PublicError);
    expect(codec.deserialize('').message).toBe('Authentication request failed');
    expect(codec.deserialize({ code: '', message: '' }).code).toBe(
      'UnknownError',
    );
    expect(() => createAuthErrorCodec([PublicError, PublicError])).toThrow(
      'Duplicate',
    );
  });
});
