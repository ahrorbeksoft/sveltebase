import { describe, expect, it } from 'vitest';
import { deferred } from '../../tests/support/fixtures.js';
import { createAsync } from './src/async.svelte.js';
import { createCookieStore } from './src/cookies.js';
import { setNotificationAdapter } from './src/notifications.js';
import {
  createId,
  getNotificationAdapter,
  pluralize,
  timestamps,
  tryCatch,
  wait,
} from './src/index.js';

describe('createCookieStore', () => {
  it('matches exact names and ignores malformed unrelated values', () => {
    const target = {
      cookie: 'broken=%E0%A4%A; item%5B0%5D=expected; item=other',
    };
    const cookies = createCookieStore(target);

    expect(cookies.get('item[0]')).toBe('expected');
    expect(cookies.get('item')).toBe('other');
  });

  it('supports zero expiry and deletion scope', () => {
    const target = { cookie: '' };
    const cookies = createCookieStore(target);

    cookies.set('session', 'value', {
      expires: 0,
      path: '/app',
      domain: 'example.test',
    });
    expect(target.cookie).toContain('max-age=0');
    expect(target.cookie).toContain('path=/app');
    expect(target.cookie).toContain('domain=example.test');

    cookies.remove('session', { path: '/app', domain: 'example.test' });
    expect(target.cookie).toContain('max-age=0');
    expect(target.cookie).toContain('path=/app');
  });

  it('handles SSR, invalid expiry, missing values, and SameSite=None safely', () => {
    const ssr = createCookieStore(null);
    expect(ssr.get('missing')).toBeNull();
    ssr.set('ignored', 'value');

    const target = { cookie: '' };
    const cookies = createCookieStore(target);
    expect(cookies.get('missing')).toBeNull();
    expect(() => cookies.set('value', 'one', { expires: Number.NaN })).toThrow(
      'finite number',
    );
    cookies.set('third-party', 'one', { sameSite: 'None', secure: false });
    expect(target.cookie).toContain('secure');
  });
});

describe('createAsync', () => {
  it('keeps a count for concurrent calls and removes completed keys', async () => {
    const first = deferred<{ success: string }>();
    const second = deferred<{ success: string }>();
    const action = createAsync((id: string) =>
      id === 'one' ? first.promise : second.promise,
    );

    const one = action.runWithKey('row', 'one');
    const two = action.runWithKey('row', 'two');
    expect(action.pendingCount('row')).toBe(2);
    expect(action.isLoading('row')).toBe(true);

    second.resolve({ success: 'saved' });
    await two;
    expect(action.pendingCount('row')).toBe(1);

    first.resolve({ success: 'saved' });
    await one;
    expect(action.pendingCount('row')).toBe(0);
    expect(action.isLoading('row')).toBe(false);
  });

  it('keeps the error state owned by the last-started invocation', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const action = createAsync((id: string) =>
      id === 'one' ? first.promise : second.promise,
    );

    const one = action.run('one');
    const two = action.run('two');
    second.resolve();
    await two;
    first.reject(new Error('stale failure'));
    await expect(one).rejects.toThrow('stale failure');
    expect(action.error).toBeNull();
  });

  it('does not allow notification adapter failures to mask results', async () => {
    const restore = setNotificationAdapter({
      success: () => {
        throw new Error('toast failed');
      },
      error: () => undefined,
    });
    const action = createAsync(async () => ({ success: 'saved' }));
    await expect(action.run()).resolves.toEqual({ success: 'saved' });
    restore();
  });

  it('exposes failures from the latest started call and supports error coercion', async () => {
    const action = createAsync(
      async () => {
        throw 'network down';
      },
      { toError: (reason) => new Error(`wrapped: ${String(reason)}`) },
    );
    await expect(action.run()).rejects.toThrow('wrapped: network down');
    expect(action.error?.message).toBe('wrapped: network down');
    expect(action.isLoading('')).toBe(false);
  });
});

describe('tryCatch and wait', () => {
  it('returns declared results and swallows reported failures', async () => {
    await expect(tryCatch(() => ({ error: 'not saved' }))).resolves.toEqual({
      error: 'not saved',
    });
    await expect(
      tryCatch(() => Promise.reject(new Error('nope'))),
    ).resolves.toBeUndefined();
  });

  it('uses per-call notifications and custom error messages', async () => {
    const messages: string[] = [];
    const notifications = {
      success: ({ message }: { message: string }) =>
        messages.push(`success:${message}`),
      error: ({ message }: { message: string }) =>
        messages.push(`error:${message}`),
    };
    await tryCatch(() => ({ success: 'saved' }), { notifications });
    await tryCatch(() => Promise.reject(new Error('private')), {
      notifications,
      onError: () => 'Try again',
    });
    expect(messages).toEqual(['success:saved', 'error:Try again']);
  });

  it('rejects invalid waits', async () => {
    await expect(wait(-1)).rejects.toThrow(RangeError);
    await expect(wait(0)).resolves.toBeUndefined();
  });

  it('formats retained pure helpers deterministically', () => {
    const create = timestamps(false);
    expect(create.createdAt).toBe(create.updatedAt);
    expect(timestamps(true)).toHaveProperty('updatedAt');
    expect(pluralize(0, { zero: 'none', other: 'items' })).toBe('none');
    expect(pluralize(1, { one: 'item', other: 'items' })).toBe('1 item');
    expect(pluralize(3, { other: (count) => `${count} matches` })).toBe(
      '3 matches',
    );
    expect(createId()).toMatch(/^[\da-f-]{36}$/i);
    expect(getNotificationAdapter()).toBeNull();
  });
});
