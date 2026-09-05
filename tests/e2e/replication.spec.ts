import { test, expect, type Page } from '@playwright/test';
import type { Harness } from './fixture/client.js';

declare global {
  interface Window {
    harness: Harness;
  }
}
const url = 'http://127.0.0.1:4174';
async function ready(page: Page) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.harness);
}
async function rows(page: Page) {
  return page.evaluate(() => window.harness.rows());
}

test('HTTP auth succeeds without sync and logs out the cookie', async ({
  page,
}) => {
  await ready(page);
  expect(
    await page.evaluate(() => window.harness.login('http-user')),
  ).toMatchObject({ subject: 'http-user' });
  expect(await page.evaluate(() => window.harness.session())).toMatchObject({
    subject: 'http-user',
  });
  await page.evaluate(() => window.harness.logout());
  expect(await page.evaluate(() => window.harness.session())).toBeNull();
  expect(
    (await page.context().cookies()).some(
      (cookie) => cookie.name === 'sf_session' && cookie.value,
    ),
  ).toBe(false);
});

test('two browser clients converge through offline reload, rejection and deletion', async ({
  context,
  page,
}) => {
  const second = await context.newPage();
  await Promise.all([ready(page), ready(second)]);
  const account = `replication-${crypto.randomUUID()}`;
  const firstDb = `first-${account}`;
  await page.evaluate((account) => window.harness.login(account), account);
  await Promise.all([
    page.evaluate(({ name, account }) => window.harness.open(name, account), {
      name: firstDb,
      account,
    }),
    second.evaluate(
      (account) => window.harness.open(`second-${account}`, account),
      account,
    ),
  ]);
  const created = await page.evaluate(() =>
    window.harness.create({ id: 'row', title: 'initial' }),
  );
  expect(
    await page.evaluate((id) => window.harness.confirmed(id), created),
  ).toBe('accepted');
  await expect
    .poll(() => rows(second))
    .toEqual([{ id: 'row', title: 'initial' }]);

  await page.evaluate(() => window.harness.stop());
  await page.evaluate(() => window.harness.update('row', 'offline'));
  expect(await rows(page)).toEqual([{ id: 'row', title: 'offline' }]);
  await page.reload();
  await page.waitForFunction(() => !!window.harness);
  await page.evaluate(
    ({ name, account }) => window.harness.open(name, account),
    { name: firstDb, account },
  );
  await expect
    .poll(() => rows(second))
    .toEqual([{ id: 'row', title: 'offline' }]);
  await expect
    .poll(() => page.evaluate(() => window.harness.pending()))
    .toBe(0);

  const rejected = await page.evaluate(() =>
    window.harness.update('row', 'forbidden'),
  );
  expect(
    await page.evaluate((id) => window.harness.confirmed(id), rejected),
  ).toBe('rejected');
  await expect
    .poll(() => rows(page))
    .toEqual([{ id: 'row', title: 'offline' }]);

  await second.evaluate(() => window.harness.stop());
  const deleted = await page.evaluate(() => window.harness.remove('row'));
  expect(
    await page.evaluate((id) => window.harness.confirmed(id), deleted),
  ).toBe('accepted');
  await second.evaluate(() => window.harness.connect());
  await expect.poll(() => rows(second)).toEqual([]);
  await second.close();
});

test('account namespaces do not replay another account outbox', async ({
  page,
}) => {
  await ready(page);
  const namespace = `accounts-${crypto.randomUUID()}`;
  await page.evaluate(() => window.harness.login('account-a'));
  await page.evaluate(
    (name) => window.harness.open(name, 'account-a'),
    namespace,
  );
  await page.evaluate(() => window.harness.stop());
  await page.evaluate(() =>
    window.harness.create({ id: 'private', title: 'account A only' }),
  );
  await page.evaluate(() => window.harness.login('account-b'));
  await page.evaluate(
    (name) => window.harness.open(name, 'account-b'),
    namespace,
  );
  expect(await rows(page)).toEqual([]);
  expect(await page.evaluate(() => window.harness.pending())).toBe(0);
});

test('auth adapter stops and purges pending old-account work before starting the next account', async ({
  page,
}) => {
  await ready(page);
  const name = `integrated-${crypto.randomUUID()}`;
  await page.evaluate(
    (name) => window.harness.integrated(name, 'integrated-a'),
    name,
  );
  await expect
    .poll(() => page.evaluate(() => window.harness.connection().status))
    .toBe('connected');
  const original = await page.evaluate(
    () => window.harness.connection().database,
  );
  await page.evaluate(() => window.harness.stop());
  await page.evaluate(() =>
    window.harness.create({ id: 'private', title: 'pending A' }),
  );
  await page.evaluate(() => window.harness.login('integrated-b'));
  await expect
    .poll(() => page.evaluate(() => window.harness.connection()))
    .toMatchObject({
      account: 'integrated-b',
      status: 'connected',
      errors: [],
    });
  expect(await rows(page)).toEqual([]);
  const confirmed = await page.evaluate(() =>
    window.harness.create({ id: 'b-row', title: 'B only' }),
  );
  expect(
    await page.evaluate((id) => window.harness.confirmed(id), confirmed),
  ).toBe('accepted');
  expect(
    await page.evaluate(
      async (name) =>
        (await indexedDB.databases()).some(
          (database) => database.name === name,
        ),
      original,
    ),
  ).toBe(false);
});
