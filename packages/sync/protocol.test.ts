import { describe, expect, it } from 'vitest';
import {
  parseClientMessage,
  parseServerMessage,
  SYNC_PROTOCOL_LIMITS,
} from './src/protocol.js';

const encode = (value: unknown) => JSON.stringify(value);

describe('sync protocol validation', () => {
  it.each([
    { v: 1, type: 'ping', nonce: 'n' },
    { v: 1, type: 'unsubscribe', channel: 'todos' },
    { v: 1, type: 'subscribe', requestId: 's', channel: 'todos', cursor: 0 },
    {
      v: 1,
      type: 'subscribe-batch',
      requestId: 'batch',
      subscriptions: [{ requestId: 's', channel: 'todos' }],
    },
    {
      v: 1,
      type: 'mutate',
      id: 'm',
      channel: 'todos',
      action: 'create',
      data: { id: '1' },
    },
    {
      v: 1,
      type: 'mutate',
      id: 'm',
      channel: 'todos',
      action: 'update',
      key: '1',
      data: { title: 'safe' },
    },
    {
      v: 1,
      type: 'mutate',
      id: 'm',
      channel: 'todos',
      action: 'delete',
      key: '1',
    },
  ])('accepts legal client variant $type', (message) => {
    expect(parseClientMessage(encode(message))).toEqual(message);
    expect(parseServerMessage(encode(message))).toBeNull();
  });

  it.each([
    { type: 'ping' },
    { v: 2, type: 'ping' },
    { v: 1, type: 'ping', extra: true },
    { v: 1, type: 'subscribe', requestId: 's', channel: 'todos', cursor: NaN },
    { v: 1, type: 'subscribe-batch', requestId: 'b', subscriptions: [] },
    {
      v: 1,
      type: 'mutate',
      id: 'm',
      channel: 'todos',
      action: 'update',
      data: {},
    },
    {
      v: 1,
      type: 'mutate',
      id: 'm',
      channel: 'todos',
      action: 'create',
      data: { id: 1 },
    },
    {
      v: 1,
      type: 'mutate',
      id: 'm',
      channel: 'todos',
      action: 'delete',
      key: '1',
      data: {},
    },
  ])('rejects malformed client frames %#', (message) => {
    expect(parseClientMessage(encode(message))).toBeNull();
  });

  it('rejects oversized frames and bounded arrays', () => {
    expect(
      parseClientMessage(
        encode({
          v: 1,
          type: 'ping',
          nonce: 'x'.repeat(SYNC_PROTOCOL_LIMITS.frameBytes),
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        encode({
          v: 1,
          type: 'subscribe-batch',
          requestId: 'b',
          subscriptions: Array.from(
            { length: SYNC_PROTOCOL_LIMITS.subscriptions + 1 },
            (_, index) => ({ requestId: String(index), channel: 'todos' }),
          ),
        }),
      ),
    ).toBeNull();
  });

  it.each([
    { v: 1, type: 'pong', nonce: 'n' },
    {
      v: 1,
      type: 'snapshot',
      requestId: 's',
      channel: 'todos',
      mode: 'full',
      rows: [{ id: '1' }],
      cursor: 1,
      hasMore: false,
    },
    { v: 1, type: 'ack', id: 'm', data: { id: '1' }, cursor: 1, revision: 1 },
    { v: 1, type: 'reject', id: 'm', error: { code: 'Denied', message: 'No' } },
    {
      v: 1,
      type: 'change',
      channel: 'todos',
      change: { kind: 'patch', key: '1', patch: { title: 'x' } },
      cursor: 2,
      revision: 2,
    },
    { v: 1, type: 'channel-reset', channel: 'todos' },
  ])('accepts legal server variant $type', (message) => {
    expect(parseServerMessage(encode(message))).toEqual(message);
    expect(parseClientMessage(encode(message))).toBeNull();
  });

  it.each([
    {
      v: 1,
      type: 'snapshot',
      requestId: 's',
      channel: 'todos',
      mode: 'full',
      rows: [{ id: 1 }],
      cursor: 1,
    },
    { v: 1, type: 'ack', id: 'm', data: { id: 1 } },
    {
      v: 1,
      type: 'change',
      channel: 'todos',
      change: { kind: 'full', key: '1', row: { id: '2' } },
      cursor: 1,
      revision: 1,
    },
    {
      v: 1,
      type: 'change',
      channel: 'todos',
      change: { kind: 'patch', key: '1', patch: { constructor: {} } },
      cursor: 1,
      revision: 1,
    },
    {
      v: 1,
      type: 'change',
      channel: 'todos',
      change: { kind: 'delete', key: '1', row: {} },
      cursor: 1,
      revision: 1,
    },
  ])('rejects malformed server frames %#', (message) => {
    expect(parseServerMessage(encode(message))).toBeNull();
  });
});
