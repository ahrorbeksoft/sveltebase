import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  getSessionFromRequest,
  parseCookies,
  signJWT,
  signSessionPayload,
  verifyJWT,
  verifySessionPayload,
} from '../../src/core/session.js';

const secret = 'test-secret-at-least-not-empty';

describe('session tokens', () => {
  it('round trips an explicitly separated identity', async () => {
    const token = await signSessionPayload(
      {
        subject: 'alice',
        v: 2,
        user: { id: 'alice', name: 'Alice' },
        claims: { role: 'editor' },
        exp: 101,
        iat: 1,
      },
      secret,
    );
    await expect(
      verifySessionPayload(token, secret, 100_000),
    ).resolves.toMatchObject({
      subject: 'alice',
      user: { id: 'alice' },
      claims: { role: 'editor' },
    });
  });

  it('expires at the exact JWT boundary', async () => {
    const token = await signJWT({ value: true }, secret, 10_000);
    await expect(verifyJWT(token, secret, 9_999)).resolves.toMatchObject({
      exp: 10,
    });
    await expect(verifyJWT(token, secret, 10_000)).rejects.toThrow(
      /exp|timestamp/i,
    );
  });

  it('rejects a different algorithm before trusting a signature', async () => {
    const header = base64urlEncode(
      new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    );
    const payload = base64urlEncode(new TextEncoder().encode('{}'));
    await expect(verifyJWT(`${header}.${payload}.`, secret)).rejects.toThrow(
      'algorithm',
    );
  });

  it('rejects invalid temporal fields and session identity mismatch', async () => {
    const timestamp = await signJWT({ exp: 'tomorrow' }, secret);
    await expect(verifyJWT(timestamp, secret)).rejects.toThrow(/exp|number/i);
    const mismatch = await signJWT(
      {
        v: 2,
        subject: 'admin',
        user: { id: 'alice' },
        claims: {},
        iat: 1,
        exp: 99_999_999_999,
      },
      secret,
    );
    await expect(verifySessionPayload(mismatch, secret)).rejects.toThrow(
      'mismatch',
    );
    const reversed = await signJWT(
      {
        v: 2,
        subject: 'alice',
        user: { id: 'alice' },
        claims: {},
        iat: 200,
        exp: 100,
      },
      secret,
    );
    await expect(
      verifySessionPayload(reversed, secret, 99_000),
    ).rejects.toThrow('timestamps');
  });

  it('parses malformed cookies independently', () => {
    const parsed = parseCookies(
      'bad=%E0%A4%A; sf_session=good%20value; token=a=b',
    );
    expect(parsed).toEqual(
      expect.objectContaining({
        bad: '%E0%A4%A',
        sf_session: 'good value',
        token: 'a=b',
      }),
    );
  });

  it('returns null for a bad session while ignoring unrelated malformed cookies', async () => {
    const token = await signSessionPayload(
      {
        v: 2,
        subject: 'alice',
        user: { id: 'alice' },
        claims: {},
        iat: 1,
        exp: 99_999_999_999,
      },
      secret,
    );
    const request = {
      headers: new Headers({ cookie: `bad=%E0%A4%A; sf_session=${token}` }),
    } as Request;
    await expect(getSessionFromRequest(request, secret)).resolves.toMatchObject(
      { subject: 'alice' },
    );
    await expect(
      getSessionFromRequest(
        { headers: new Headers({ cookie: 'sf_session=bad' }) } as Request,
        secret,
      ),
    ).resolves.toBeNull();
  });

  it('validates base64url input', () => {
    expect(
      base64urlDecode(base64urlEncode(new Uint8Array([0, 127, 255]))),
    ).toEqual(new Uint8Array([0, 127, 255]));
    expect(() => base64urlDecode('%%%')).toThrow('base64url');
    expect(() => base64urlDecode('a')).toThrow('base64url');
  });

  it('rejects every malformed session boundary', async () => {
    const future = 99_999_999_999;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        { subject: 'a', user: { id: 'a' }, claims: {}, iat: 1, exp: future },
        /version/,
      ],
      [
        {
          v: 2,
          subject: '',
          user: { id: 'a' },
          claims: {},
          iat: 1,
          exp: future,
        },
        /subject/,
      ],
      [
        { v: 2, subject: 'a', user: [], claims: {}, iat: 1, exp: future },
        /user/,
      ],
      [
        {
          v: 2,
          subject: 'a',
          user: { id: 'a' },
          claims: [],
          iat: 1,
          exp: future,
        },
        /claims/,
      ],
      [
        {
          v: 2,
          subject: 'a',
          user: { id: 'a' },
          claims: {},
          iat: 1.5,
          exp: future,
        },
        /issued-at|timestamps/,
      ],
    ];
    for (const [payload, message] of cases) {
      await expect(
        verifySessionPayload(await signJWT(payload, secret), secret),
      ).rejects.toThrow(message);
    }
    await expect(signJWT({}, '')).rejects.toThrow('secret');
  });
});
