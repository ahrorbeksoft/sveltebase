# @sveltebase/i18n

Request-scoped Svelte i18n with pure ICU translation and date formatting helpers.

```bash
bun add @sveltebase/i18n
```

`intl-messageformat` provides ICU message parsing. This package does not depend on React, `@sveltebase/state`, browser storage, or cookies.

## Define languages

```ts
import type { LanguageDefinition } from '@sveltebase/i18n';

export const languages = [
  {
    code: 'en',
    label: 'English',
    messages: { hello: 'Hello, {name}', 'just-now': 'Just now' },
  },
  {
    code: 'uz',
    label: "O'zbek",
    messages: { hello: 'Salom, {name}', 'just-now': 'Hozirgina' },
  },
] as const satisfies readonly LanguageDefinition[];
```

The array must have at least one item. Locale codes must be unique, nonempty strings. The first language is the fallback unless `fallbackLocale` is supplied. An unsupported locale resolves to that fallback. When a key is absent in the active catalog, the fallback catalog is tried; if it is still absent, `t` returns the key or `missingMessage(key)` when configured.

## SvelteKit setup

Create an instance inside a root layout, where it is isolated to the SSR request. Do not export an instance from a module.

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { createI18n, provideI18n } from '@sveltebase/i18n';
  import { languages } from '$lib/i18n';

  let { data, children } = $props();
  const i18n = createI18n({
    languages,
    locale: data.locale,
    timeZone: 'Asia/Tashkent',
  });
  provideI18n(i18n);
</script>

{@render children()}
```

The server layout should return only its validated locale value. Passing all request cookies to the client is unnecessary and can disclose unrelated cookie data.

In descendants, retrieve the provided instance during initialization:

```svelte
<script lang="ts">
  import { getFormat, getI18n, getTranslations } from '@sveltebase/i18n';

  const i18n = getI18n();
  const t = getTranslations();
  const format = getFormat();
</script>

<h1>{t('hello', { name: 'Amina' })}</h1>
<button onclick={() => (i18n.locale = 'uz')}>O'zbek</button>
<p>{format(new Date(), { preset: 'full', withTime: true })}</p>
```

## Persistence

Persistence is optional and injected by the app. The adapter is only read while creating that one instance and is written when its locale changes.

```ts
const i18n = createI18n({
  languages,
  locale: serverLocale,
  storage: {
    get: () => localStorage.getItem('locale') ?? undefined,
    set: (locale) => localStorage.setItem('locale', locale),
  },
});
```

Use a cookie adapter when the server also needs the locale. Keep browser-only adapters out of SSR code.

## Pure helpers and clocks

`createTranslator` and `createFormatter` have no Svelte or storage dependency. Import them from the `@sveltebase/i18n/core` subpath to avoid loading Svelte. They cache their ICU/Intl work by locale and time zone. Supply the time zone and clock when rendering or testing needs a specific result:

```ts
import { createFormatter, createTranslator } from '@sveltebase/i18n/core';

const t = createTranslator(languages, 'en');
const format = createFormatter(languages, 'en', {
  timeZone: 'Asia/Tashkent',
  now: () => new Date('2026-01-01T12:00:00Z'),
});

t('hello', { name: 'Amina' });
format(0, { preset: 'full' });
format(createdAt, { preset: 'relative' });
```

Every instant-based date preset uses the configured IANA time zone, including Uzbek date parts and timeline labels. The default is `UTC`, avoiding server/browser time-zone drift. Relative labels read the supplied clock on each format call, so they do not become stale through caching. Invalid dates and malformed `HH:mm[:ss]` time-only strings return `undefined`; time-only strings represent wall-clock time and are localized without applying an offset.

Available presets are `default`, `custom`, `relative`, `birthday`, `month`, `timestring`, and `full`. `relative` and future `custom` dates use `just-now`, `minutes-ago`, `in-minutes`, and equivalent hour/day/week/month/year keys from the configured messages.

## Typed keys

`createI18n` infers dot-separated keys from a literal language catalog. Keep the `as const` declaration above and `i18n.t('hello')` is checked against it. The standalone `createTranslator` accepts string keys for generic server utilities.
