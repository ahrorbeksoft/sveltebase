import { test, expect } from '@playwright/test';

test('demo hydrates scoped locale and renders interactive package examples', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.addCookies([
    { name: 'locale', value: 'en', domain: '127.0.0.1', path: '/' },
    {
      name: 'private-cookie',
      value: 'do-not-serialize',
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  const html = await response!.text();
  expect(html).not.toContain('do-not-serialize');
  await expect(page.locator('main[data-ready="true"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'English', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.getByText('Counter: 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  await expect(page.getByText('completed', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Queue offline change', exact: true })
    .click();
  await expect(
    page.getByText('Pending changes: 1', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('SSR locale does not bleed between requests', async ({ request }) => {
  const [english, uzbek] = await Promise.all([
    request.get('/', { headers: { cookie: 'locale=en' } }),
    request.get('/', { headers: { cookie: 'locale=uz' } }),
  ]);
  expect(english.status()).toBe(200);
  expect(uzbek.status()).toBe(200);
  expect(await english.text()).toContain('English (en)');
  expect(await uzbek.text()).toContain('O‘zbekcha (uz)');
});
