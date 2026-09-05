import { describe, expect, it } from 'vitest';
import {
  createErrorCodec,
  SerializableError,
  serializeSyncError,
} from './src/errors.js';

class PublicError extends SerializableError {
  static readonly code = 'PublicError';
}

describe('sync error boundary', () => {
  it('exposes only explicitly serializable errors', () => {
    expect(serializeSyncError(new PublicError('safe'))).toEqual({
      code: 'PublicError',
      message: 'safe',
    });
    expect(serializeSyncError(new Error('database password leaked'))).toEqual({
      code: 'UnknownError',
      message: 'Unknown error',
    });
    expect(serializeSyncError('secret')).toEqual({
      code: 'UnknownError',
      message: 'Unknown error',
    });
  });

  it('restores registered and unknown stable error codes', () => {
    const codec = createErrorCodec([PublicError]);
    expect(
      codec.deserialize({ code: 'PublicError', message: 'safe' }),
    ).toBeInstanceOf(PublicError);
    expect(
      codec.deserialize({ code: 'Other', message: 'detail' }),
    ).toMatchObject({ code: 'Other', message: 'detail' });
    expect(codec.deserialize('legacy')).toMatchObject({
      code: 'UnknownError',
      message: 'legacy',
    });
    expect(codec.deserialize({ code: '', message: 1 } as never)).toMatchObject({
      code: 'UnknownError',
      message: 'Unknown error',
    });
  });

  it('rejects duplicate registered codes and contains bad constructors', () => {
    expect(() => createErrorCodec([PublicError, PublicError])).toThrow(
      'Duplicate',
    );
    class Broken extends SerializableError {
      static readonly code = 'Broken';
      constructor(message: string) {
        super(message);
        throw new Error('broken');
      }
    }
    expect(
      createErrorCodec([Broken]).deserialize({
        code: 'Broken',
        message: 'safe',
      }),
    ).toMatchObject({ code: 'Broken', message: 'safe' });
  });
});
