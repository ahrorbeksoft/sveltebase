# @sveltebase/i18n

Locale state, translations, and date formatting for Svelte 5. Built on [use-intl](https://github.com/amannn/use-intl) and `@sveltebase/state`.

## Install

```bash
bun add @sveltebase/i18n
```

## Quick start

Define your languages once and create an i18n instance:

```ts
// src/lib/i18n.ts
import { createI18n } from "@sveltebase/i18n";

export const languages = [
  {
    code: "en",
    label: "English",
    messages: {
      "app-title": "My app",
      "welcome": "Welcome, {name}",
      "just-now": "Just now",
      "minutes-ago": "{minutes} minutes ago",
      "hours-ago": "{hours} hours ago",
      "days-ago": "{days} days ago",
      "weeks-ago": "{weeks} weeks ago",
      "months-ago": "{months} months ago",
      "years-ago": "{years} years ago",
      "in-minutes": "in {minutes} minutes",
      "in-hours": "in {hours} hours",
      "in-days": "in {days} days",
      "in-weeks": "in {weeks} weeks",
      "in-months": "in {months} months",
      "in-years": "in {years} years",
      "today-at": "Today at {time}",
      "yesterday-at": "Yesterday at {time}"
    }
  },
  {
    code: "uz",
    label: "O'zbek",
    messages: {
      "app-title": "Mening ilovam",
      "welcome": "Xush kelibsiz, {name}",
      "just-now": "Hozirgina",
      "minutes-ago": "{minutes} daqiqa oldin",
      "hours-ago": "{hours} soat oldin",
      "days-ago": "{days} kun oldin",
      "weeks-ago": "{weeks} hafta oldin",
      "months-ago": "{months} oy oldin",
      "years-ago": "{years} yil oldin",
      "in-minutes": "{minutes} daqiqadan keyin",
      "in-hours": "{hours} soatdan keyin",
      "in-days": "{days} kundan keyin",
      "in-weeks": "{weeks} haftadan keyin",
      "in-months": "{months} oydan keyin",
      "in-years": "{years} yildan keyin",
      "today-at": "Bugun {time} da",
      "yesterday-at": "Kecha {time} da"
    }
  }
] as const;

export const i18n = createI18n(languages);
```

- The first language is the fallback.
- Locale is stored in a cookie named `"locale"` by default. Pass a second argument to change it: `createI18n(languages, "my-locale")`.
- Keep the same message keys across languages.

## SvelteKit setup

Pass only the locale cookie value so SSR uses the user’s saved locale:

**`src/routes/+layout.server.ts`**

```ts
export function load({ cookies }) {
  return { locale: cookies.get("locale") };
}
```

**`src/routes/+layout.svelte`**

```svelte
<script lang="ts">
  import { i18n } from "$lib/i18n";

  let { data } = $props();
  i18n.init(() => data.locale);
</script>

{@render children()}
```

Call `i18n.init()` (with or without a locale cookie value) before any child uses `getTranslations` or `getFormat`. Without a cookie value, it still sets up context and uses the browser cookie or the fallback language.

`init` accepts the serialized value returned by `cookies.get("locale")` (for example, `'"uz"'`), or a getter for that value. For a custom storage key, read that key in your server load.

## Translating text

Prefer the instance methods — they work anywhere (components, `<script module>`, utils):

```ts
import { i18n } from "$lib/i18n";

i18n.t("app-title");
i18n.t("welcome", { name: "Jane" });
i18n.format(new Date());
i18n.format(createdAt, { preset: "relative" });
```

```svelte
<script lang="ts">
  import { i18n } from "$lib/i18n";
</script>

<h1>{i18n.t("app-title")}</h1>
<p>{i18n.t("welcome", { name: "Jane" })}</p>

<button onclick={() => (i18n.locale = "en")}>English</button>
<button onclick={() => (i18n.locale = "uz")}>O'zbek</button>
```

In components you can still use context helpers after `i18n.init(...)`:

```svelte
<script lang="ts">
  import { getTranslations, getFormat } from "@sveltebase/i18n";

  const t = getTranslations();
  const format = getFormat();
</script>
```

Those must run during component initialization — not in `<script module>`. Use `i18n.t` / `i18n.format` there instead.

Messages support ICU placeholders via use-intl (`"Welcome, {name}"` → `{ name: "Jane" }`).

### Optional: typed message keys

Register your catalog so TypeScript knows valid keys:

```ts
// src/app.d.ts
import type { languages } from "$lib/i18n";

type AppMessages = (typeof languages)[number]["messages"];

declare module "use-intl/core" {
  interface AppConfig {
    Messages: AppMessages;
  }
}
```

Nested message objects become dot-separated keys (`settings.account.title`).

## The i18n instance

```ts
i18n.languages;        // your language array
i18n.locale;           // get/set active locale (persisted to cookie)
i18n.currentLanguage;  // full definition of the active language
i18n.t(key, values?);  // translate (no context needed)
i18n.format(value, options?); // format dates (no context needed)
i18n.init(localeCookie?); // set up context (+ optional serialized locale cookie)
```

Setting `locale` to an unknown code falls back to the first language.

## Formatting dates

```ts
i18n.format(new Date());
i18n.format(createdAt, { withTime: true });
i18n.format(createdAt, { preset: "relative" });
```

Pass a `Date`, a millisecond timestamp, or a date string. Falsy values (`undefined`, `""`, `0`) return `undefined`.

Date and time labels use `Asia/Tashkent`, consistently across the browser and server. Time-only strings keep their given hour and minute.

### Presets

| Preset | What you get |
| --- | --- |
| `default` (default) | Short date; year omitted if it’s this year. `withTime: true` adds hour and minute. |
| `custom` | Timeline-style: “just now”, “today at …”, weekday, then full date; future dates use relative labels. |
| `relative` | Always relative (“5 minutes ago”, “in 2 hours”). |
| `birthday` | Full date, no time. |
| `month` | Month only (or month + year if not this year). |
| `timestring` | Time-only strings like `"08:30:00"`. |
| `full` | Full localized date; `withTime: true` adds time. |

```ts
format(date);                                    // default
format(date, { withTime: true });
format(date, { preset: "custom" });
format(date, { preset: "relative" });
format(birthday, { preset: "birthday" });
format(date, { preset: "month" });
format("08:30:00", { preset: "timestring" });
format(date, { preset: "full", withTime: true });
```

Relative and custom labels use message keys like `just-now`, `minutes-ago`, `today-at`, etc. Include those keys in every language if you use those presets (see the quick-start example).

## License

ISC

## Agent skills (TanStack Intent)

This package ships its own skill and a shared Sveltebase overview. From your app:

```sh
npx @tanstack/intent@latest install
npx @tanstack/intent@latest list
npx @tanstack/intent@latest load '@sveltebase/i18n#sveltebase'
npx @tanstack/intent@latest load '@sveltebase/i18n#i18n'
```

Select this package during Intent's first-time permission review. The skills come
from your installed package version; older releases may not include them.
