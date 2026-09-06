---
name: i18n
description: Configure @sveltebase/i18n language catalogs, locale-cookie hydration, Svelte context, ICU translations, typed message keys, and date formatting. Use for this package's localization API, including SSR and timezone behavior.
license: ISC
metadata:
  library: "@sveltebase/i18n"
---

# Sveltebase i18n

Read [the package README](../../README.md) for date-label catalogs and all presets.
Install `@sveltebase/i18n` to use translations and a persisted locale.

## Catalog and instance

```ts
import { createI18n } from '@sveltebase/i18n';

const languages = [
  { code: 'en', label: 'English', messages: { welcome: 'Welcome, {name}' } },
  { code: 'uz', label: "O'zbek", messages: { welcome: 'Xush kelibsiz, {name}' } },
] as const;
const i18n = createI18n(languages);
i18n.t('welcome', { name: 'Jane' });
i18n.locale = 'uz';
```

Provide a non-empty language array. The first language is the fallback; unknown
locale assignments fall back to it. Keep message keys consistent between catalogs.
Share immutable language definitions, but scope the mutable i18n instance to the
request/component tree when SSR can serve different users concurrently.

`createI18n(languages, storageKey?)` defaults to cookie key `locale`. Read that exact
key in `+layout.server.ts` and return its serialized `cookies.get(key)` value.
Call `i18n.init(() => data.localeCookie)` during parent component initialization.
The input is JSON text (e.g. `'"uz"'`), not a bare locale code. In the browser the
underlying state hydrates from the cookie; on the server `init` applies the load value.

## Context and reactivity

`i18n.t` and `i18n.format` do not need Svelte context and read the current locale on
invocation. Use them when the instance is available. To render reactive text, invoke
them in markup or a derived expression, not a one-time assignment in setup code.

`getTranslations()` and `getFormat()` require an ancestor's `i18n.init()` and must
be called during component initialization. Do not call context helpers from module
scripts, event handlers, or arbitrary utilities. `init()` without a cookie still
installs context; invoke it before children use the helpers.

For typed keys, augment `use-intl/core`'s `AppConfig.Messages` with the application's
catalog type in a `.d.ts` file. Nested keys become dot-separated paths. Without
augmentation, the package accepts string keys. Use ICU placeholders and pass named
values rather than manually replacing message fragments.

## Date formatting constraints

`i18n.format(value, { preset, withTime? })` accepts Date, millisecond timestamp, or
string. Falsy values, including numeric `0`, return `undefined`. Date/time labels
use **Asia/Tashkent**. Time-only strings retain their supplied hour/minute.

Presets: `default`, `custom`, `relative`, `birthday`, `month`, `timestring`, `full`.
`withTime` applies where supported, e.g. default/full. Relative and custom output
needs the complete date-label messages listed in the README in every language:
`just-now`, `minutes-ago` through `years-ago`, `in-minutes` through `in-years`,
`today-at`, and `yesterday-at`. Future dates use future-relative labels.

