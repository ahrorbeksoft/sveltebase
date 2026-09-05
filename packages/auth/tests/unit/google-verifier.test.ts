import { beforeEach, describe, expect, it, vi } from 'vitest';
import { base64urlEncode } from '../../src/index.js';
import {
  clearGoogleKeyCache,
  verifyIdToken,
} from '../../src/google/verifier.js';

async function key(id: string) {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  return {
    id,
    pair,
    jwk: {
      ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
      kid: id,
      alg: 'RS256',
      use: 'sig',
    },
  };
}

async function token(
  material: Awaited<ReturnType<typeof key>>,
  overrides: Record<string, unknown> = {},
) {
  const header = base64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: material.id }),
    ),
  );
  const payload = base64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        azp: 'client',
        aud: 'client',
        sub: '123',
        email: 'a@example.test',
        email_verified: true,
        name: 'Ada',
        iat: 900,
        exp: 1100,
        nonce: 'nonce',
        ...overrides,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    material.pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64urlEncode(new Uint8Array(signature))}`;
}

describe('Google ID token verification', () => {
  beforeEach(() => clearGoogleKeyCache());

  it('verifies signature and claim types and caches keys by max-age', async () => {
    const material = await key('one');
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [material.jwk] }), {
          headers: { 'cache-control': 'public, max-age=60' },
        }),
    );
    const credential = await token(material);
    const options = {
      credential,
      clientId: 'client',
      nonce: 'nonce',
      now: () => 1_000_000,
      fetch: fetcher,
    };
    await expect(verifyIdToken(options)).resolves.toMatchObject({ sub: '123' });
    await expect(verifyIdToken(options)).resolves.toMatchObject({
      email_verified: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts tokens without optional presenter and profile claims', async () => {
    const material = await key('minimal');
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ keys: [material.jwk] })),
    );
    const credential = await token(material, {
      azp: undefined,
      email: undefined,
      email_verified: undefined,
      name: undefined,
    });

    await expect(
      verifyIdToken({
        credential,
        clientId: 'client',
        now: () => 1_000_000,
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ sub: '123' });
  });

  it('refetches once for key rotation', async () => {
    const oldKey = await key('old');
    const newKey = await key('new');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [oldKey.jwk] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [newKey.jwk] })),
      );
    await expect(
      verifyIdToken({
        credential: await token(newKey),
        clientId: 'client',
        now: () => 1_000_000,
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ sub: '123' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares a rotated-key refresh across concurrent verification', async () => {
    const oldKey = await key('old-concurrent');
    const newKey = await key('new-concurrent');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [oldKey.jwk] })),
      )
      .mockImplementationOnce(async () => {
        await gate;
        return new Response(JSON.stringify({ keys: [newKey.jwk] }));
      });
    const credential = await token(newKey);
    const first = verifyIdToken({
      credential,
      clientId: 'client',
      now: () => 1_000_000,
      fetch: fetcher,
    });
    const second = verifyIdToken({
      credential,
      clientId: 'client',
      now: () => 1_000_000,
      fetch: fetcher,
    });
    await Promise.resolve();
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('enforces exact expiration, nonce, audience, and finite claim types', async () => {
    const material = await key('claims');
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ keys: [material.jwk] })),
    );
    await expect(
      verifyIdToken({
        credential: await token(material, { exp: 1000 }),
        clientId: 'client',
        now: () => 1_000_000,
        fetch: fetcher,
      }),
    ).rejects.toThrow('expired');
    await expect(
      verifyIdToken({
        credential: await token(material),
        clientId: 'other',
        now: () => 1_000_000,
        fetch: fetcher,
      }),
    ).rejects.toThrow('audience');
    await expect(
      verifyIdToken({
        credential: await token(material, { azp: 'other' }),
        clientId: 'client',
        now: () => 1_000_000,
        fetch: fetcher,
      }),
    ).rejects.toThrow('authorized party');
    await expect(
      verifyIdToken({
        credential: await token(material),
        clientId: 'client',
        nonce: 'wrong',
        now: () => 1_000_000,
        fetch: fetcher,
      }),
    ).rejects.toThrow('nonce');
    await expect(
      verifyIdToken({
        credential: await token(material, { exp: 'soon' }),
        clientId: 'client',
        now: () => 1_000_000,
        fetch: fetcher,
      }),
    ).rejects.toThrow('claims');
  });
});
