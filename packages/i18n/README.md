# `@sveltebase/i18n`

Simple i18n utilities for Svelte 5 apps.

`@sveltebase/i18n` gives you a small API for:

- defining your supported languages
- storing the active locale
- reading translations in components
- formatting dates and times for the current locale

It is designed to stay lightweight and work nicely with Svelte 5 runes.

## Install

Install the package with Bun:

```bash
bun add @sveltebase/i18n
```

## What it exports

- `createI18n`
- `getTranslations`
- `getFormat`

## Quick start

Create a shared i18n module:

```ts
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
      "today-at": "Today at {time}",
      "yesterday-at": "Yesterday at {time}"
    }
  },
  {
    code: "uz",
    label: "O‘zbekcha",
    messages: {
      "app-title": "Mening ilovam",
      "welcome": "Xush kelibsiz, {name}",
      "just-now": "Hozirgina",
      "minutes-ago": "{minutes} daqiqa oldin",
      "today-at": "Bugun {time} da",
      "yesterday-at": "Kecha {time} da"
    }
  }
] as const;

export const i18n = createI18n(languages, "locale");
```

Then initialize it before using translations or formatters.

In SvelteKit, the recommended quick start is to load all cookies in `+layout.server.ts`, pass them to `+layout.svelte`, and initialize i18n there. That lets the package restore the saved locale before your UI reads translations, so the correct language loads right away instead of first rendering with the fallback locale and switching later.

In `+layout.server.ts`:

```ts
export function load({ cookies }) {
  return {
    cookies: cookies.getAll()
  };
}
```

Then in `+layout.svelte`:

```svelte
<script lang="ts">
  import { i18n } from "./i18n";

  let { data } = $props();

  i18n.init(() => data.cookies);
</script>
```

## Basic usage in a Svelte component

```svelte
<script lang="ts">
  import { getTranslations, getFormat } from "@sveltebase/i18n";
  import { i18n } from "$lib/i18n";

  const t = getTranslations();
  const format = getFormat();

  function switchLocale(locale: string) {
    i18n.locale = locale;
  }
</script>

<h1>{t("app-title")}</h1>
<p>{t("welcome", { name: "Jane" })}</p>
<p>{format(new Date(), { preset: "full", withTime: true })}</p>

<button onclick={() => switchLocale("en")}>English</button>
<button onclick={() => switchLocale("uz")}>O‘zbekcha</button>
```

## Creating your language list

Each language should have:

- `code`: locale code
- `label`: readable language name
- `messages`: translation dictionary

Example:

```ts
const languages = [
  {
    code: "en",
    label: "English",
    messages: {
      "app-title": "My app",
      "nav.home": "Home",
      "nav.settings": "Settings"
    }
  },
  {
    code: "uz",
    label: "O‘zbekcha",
    messages: {
      "app-title": "Mening ilovam",
      "nav.home": "Bosh sahifa",
      "nav.settings": "Sozlamalar"
    }
  }
] as const;
```

You can also import messages from JSON or split them across files if that fits your app better.

## Initialization

Call `init()` before using `getTranslations()` or `getFormat()`.

### Without cookies

If you do not have cookies available yet, you can initialize normally:

```ts
import { i18n } from "$lib/i18n";

i18n.init();
```

### With cookies in SvelteKit for faster first render

In SvelteKit, the recommended approach is to load all cookies in `+layout.server.ts`, return them from `load`, and then pass that data to `i18n.init(() => data.cookies)` in `+layout.svelte`.

This lets `@sveltebase/i18n` restore the saved locale before your UI reads translations, so the correct language is available immediately and you avoid rendering the fallback language first.

In `+layout.server.ts`:

```ts
export function load({ cookies }) {
  return {
    cookies: cookies.getAll()
  };
}
```

Then in `+layout.svelte`:

```svelte
<script lang="ts">
  import { i18n } from "$lib/i18n";

  let { data } = $props();

  i18n.init(() => data.cookies);
</script>

<slot />
```

The function passed to `i18n.init(...)` should return an array of cookie objects in this shape:

```ts
type Cookie = {
  name: string;
  value: string;
};
```

## API

## `createI18n(languages, localeStorageKey?)`

Creates an i18n instance.

### Parameters

- `languages`: an array of language definitions
- `localeStorageKey?`: the key used to persist the locale, defaults to `"locale"`

### Returns

An object with:

- `languages`
- `locale`
- `currentLanguage`
- `init(cookies?)`

### Example

```ts
import { createI18n } from "@sveltebase/i18n";

const languages = [
  {
    code: "en",
    label: "English",
    messages: {
      hello: "Hello"
    }
  },
  {
    code: "uz",
    label: "O‘zbekcha",
    messages: {
      hello: "Salom"
    }
  }
] as const;

const i18n = createI18n(languages, "locale");
```

## `getTranslations()`

Returns a translation function for the current locale.

### Example

```ts
import { getTranslations } from "@sveltebase/i18n";

const t = getTranslations();

t("hello");
t("welcome", { name: "Jane" });
```

## `getFormat()`

Returns a formatter function for locale-aware display.

### Example

```ts
import { getFormat } from "@sveltebase/i18n";

const format = getFormat();

format(new Date(), { preset: "full" });
format(new Date(), { preset: "custom", withTime: true });
format("13:45:00", { preset: "timestring" });
```

## Locale switching

You can switch the active locale by assigning to `i18n.locale`:

```ts
i18n.locale = "en";
```

You can also read the current language object:

```ts
console.log(i18n.currentLanguage.label);
```

## Formatting presets

`getFormat()` supports these presets:

- `default`
- `custom`
- `birthday`
- `month`
- `timestring`
- `full`

### Example

```ts
const format = getFormat();

format(new Date(), { preset: "month" });
format(new Date(), { preset: "birthday" });
format(new Date(), { preset: "full", withTime: true });
format("08:30:00", { preset: "timestring" });
```

## Type safety

When your language array is declared with `as const`, locale codes are inferred automatically.

```ts
const languages = [
  {
    code: "en",
    label: "English",
    messages: { hello: "Hello" }
  },
  {
    code: "uz",
    label: "O‘zbekcha",
    messages: { hello: "Salom" }
  }
] as const;
```

That improves typing for values like:

- `i18n.locale`
- `i18n.currentLanguage`
- language code parameters in your own functions

## Notes

- Call `init()` before using `getTranslations()` or `getFormat()`.
- Passing cookies into `init(cookies)` during the initial render helps the correct locale load faster and avoids rendering the fallback language first.
- The first language in the array is used as the fallback locale.
- Locale state is persisted using `@sveltebase/state`.
- Date formatting includes locale-specific behavior for Uzbek.
- This package is intended for Svelte 5 apps.

## License

ISC
