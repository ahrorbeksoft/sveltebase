# @sveltebase/i18n

Small, typed internationalization helpers for Svelte 5. The package stores the
active locale, restores it from cookies, translates messages through
use-intl, and provides date, time, month, birthday, and relative-time
formatting.

## Install

~~~bash
bun add @sveltebase/i18n
~~~

The package depends on @sveltebase/state and use-intl. svelte is a peer
dependency.

## Exports

Runtime exports:

~~~ts
import {
  createI18n,
  getFormat,
  getTranslations
} from "@sveltebase/i18n";
~~~

Public types:

~~~ts
import type {
  CreateI18nReturn,
  CurrentLanguage,
  Format,
  FormatOptions,
  I18nInstance,
  LanguageDefinition,
  MaybeGetter,
  MessageKey,
  MessageValue,
  Messages,
  RegisteredMessages,
  Translate,
  TranslationValues
} from "@sveltebase/i18n";
~~~

## Quick start

Define the languages in one shared module. Keep the array as const so locale
codes and current-language types are inferred as literals.

~~~ts
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

export const i18n = createI18n(languages, "locale");
~~~

The first language is the fallback locale. localeStorageKey is optional and
defaults to locale, the cookie key used to persist the selected locale.

## SvelteKit initialization

Call i18n.init in a root component before descendants call getTranslations or
getFormat. In SvelteKit, pass request cookies from a server layout so SSR
starts with the saved locale:

src/routes/+layout.server.ts

~~~ts
export function load({ cookies }) {
  return { cookies: cookies.getAll() };
}
~~~

src/routes/+layout.svelte

~~~svelte
<script lang="ts">
  import { i18n } from "$lib/i18n";

  let { data } = $props();
  i18n.init(() => data.cookies);
</script>

<slot />
~~~

The getter must return objects shaped like:

~~~ts
type Cookie = {
  name: string;
  value: string;
};
~~~

Without server cookies, initialize normally with i18n.init(). Initialization
restores the persisted locale and installs the instance in Svelte context.
Calling the context helpers before initialization throws.

## Translation usage

~~~svelte
<script lang="ts">
  import { getTranslations } from "@sveltebase/i18n";
  import { i18n } from "$lib/i18n";

  const t = getTranslations();

  function switchLocale(locale: "en" | "uz") {
    i18n.locale = locale;
  }
</script>

<h1>{t("app-title")}</h1>
<p>{t("welcome", { name: "Jane" })}</p>

<button onclick={() => switchLocale("en")}>English</button>
<button onclick={() => switchLocale("uz")}>O'zbek</button>
~~~

### getTranslations()

Returns a translator bound to the initialized i18n instance. The translator
reads the current locale whenever it is called.

~~~ts
type Translate = <TKey extends MessageKey>(
  key: TKey,
  values?: TranslationValues
) => string;

type TranslationValues = Record<string, string | number | Date>;
~~~

Values use the ICU message behavior provided by use-intl. A message such as
"Welcome, {name}" can receive { name: "Jane" }.

MessageKey is a dot-separated key union when message types are registered with
use-intl. Without message augmentation it falls back to string.

### Optional message type registration

When the app wants compile-time message-key checking, register the message
catalog with use-intl/core:

~~~ts
// src/app.d.ts
import type { languages } from "$lib/i18n";

type AppMessages = (typeof languages)[number]["messages"];

declare module "use-intl/core" {
  interface AppConfig {
    Messages: AppMessages;
  }
}
~~~

Nested message objects become dot-separated keys such as
settings.account.title.

## createI18n(languages, localeStorageKey?)

Creates an I18nInstance.

~~~ts
function createI18n<
  const TLanguages extends readonly LanguageDefinition[]
>(
  languages: TLanguages,
  localeStorageKey?: string
): I18nInstance<TLanguages>;
~~~

### Language definition

~~~ts
type LanguageDefinition<
  TLocale extends string = string,
  TMessages extends Messages = Messages
> = {
  code: TLocale;
  label: string;
  messages: TMessages;
};

type MessageValue = string | { [key: string]: MessageValue };

type Messages = {
  [key: string]: MessageValue;
};
~~~

- code is the locale passed to Intl and used for persistence.
- label is the application-facing language name.
- messages is the use-intl message catalog.
- Every language should use the same message keys if the UI can switch between
  them.

### localeStorageKey

Defaults to locale. It is the cookie name used by the underlying
PersistentState. A different key is useful when multiple independent i18n
instances exist.

### Returned I18nInstance

~~~ts
interface I18nInstance<TLanguages extends readonly LanguageDefinition[]> {
  readonly languages: TLanguages;
  locale: LocaleCode<TLanguages>;
  readonly currentLanguage: CurrentLanguage<TLanguages>;
  init(cookies?: MaybeGetter<Cookie[] | undefined>): void;
}
~~~

- languages returns the original language array.
- locale gets or sets the active locale. Assignment persists the locale in a
  cookie and is validated against configured language codes.
- currentLanguage returns the selected language definition. Missing or invalid
  persisted values fall back to the first language.
- init optionally reads cookies and installs the instance into Svelte context.

An empty language array throws when createI18n is called.

## getFormat()

Returns a formatter bound to the current i18n context:

~~~ts
type Format = (
  value?: Date | number | string,
  options?: FormatOptions
) => string | undefined;
~~~

value may be a Date, a millisecond timestamp, or a date string accepted by the
JavaScript Date constructor. The high-level formatter uses the Asia/Tashkent
time zone for its Intl-based output.

A falsy value such as undefined, an empty string, or 0 returns undefined.

## Formatting options

~~~ts
type FormatOptions = {
  preset?:
    | "default"
    | "custom"
    | "birthday"
    | "month"
    | "timestring"
    | "full"
    | "relative";
  withTime?: boolean;
};
~~~

### default

The default preset uses a short date style:

- dates in the current year omit the year;
- older dates include the year;
- withTime: true appends the localized hour and minute.

~~~ts
format(new Date());
format(new Date(), { withTime: true });
~~~

### custom

Creates a timeline-style label for past dates:

- less than one minute: just-now;
- less than one hour: minutes-ago;
- today: today-at;
- yesterday: yesterday-at;
- another date in the current week: weekday and time;
- another date in the current year: month and day;
- older dates: year, month, and day.

The relative labels use the current locale's messages. Uzbek output uses the
package's Uzbek month and weekday names.

~~~ts
format(date, { preset: "custom" });
format(date, { preset: "custom", withTime: true });
~~~

### relative

Always returns a relative phrase. It compares the input with now using whole
minute, hour, day, week, month, and year thresholds:

- under one minute: just-now;
- under one hour: minutes;
- under one day: hours;
- under seven days: days;
- under thirty days: weeks;
- under 365 days: months;
- otherwise: years.

Future values use the in-* message keys. Past values use the *-ago keys.

~~~ts
format(Date.now() - 5 * 60 * 1000, { preset: "relative" });
format(Date.now() + 2 * 60 * 60 * 1000, { preset: "relative" });
~~~

### birthday

Formats a complete date with year, month, and day. It does not include a time.

~~~ts
format(birthday, { preset: "birthday" });
~~~

### month

Formats only the month for dates in the current year. Dates in another year
include both month and year.

~~~ts
format(date, { preset: "month" });
~~~

### timestring

Accepts a time-only string such as "08:30:00" and formats its hour and minute
using the current locale.

~~~ts
format("08:30:00", { preset: "timestring" });
~~~

### full

Formats a complete localized date. Add withTime: true for the hour and minute.

~~~ts
format(date, { preset: "full" });
format(date, { preset: "full", withTime: true });
~~~

## Required messages

For preset relative, every language must provide these keys:

~~~text
just-now
minutes-ago
hours-ago
days-ago
weeks-ago
months-ago
years-ago
in-minutes
in-hours
in-days
in-weeks
in-months
in-years
~~~

The corresponding values receive minutes, hours, days, weeks, months, or years
as appropriate. For preset custom, provide today-at and yesterday-at as well.

Example:

~~~ts
const messages = {
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
};
~~~

## Type aliases

- LocaleCode<TLanguages> is the union of configured language codes.
- CurrentLanguage<TLanguages> is the union of configured language objects.
- RegisteredMessages is the message type found in use-intl/core app
  configuration.
- MessageKey is the nested dot-separated message-key union or string.
- Translate is the function type returned by getTranslations.
- Format is the function type returned by getFormat.
- CreateI18nReturn<TLanguages> is an alias for I18nInstance<TLanguages>.
- MaybeGetter<T> is re-exported from @sveltebase/state.

## Runtime notes

- Initialize before calling getTranslations or getFormat.
- The first configured language is always the fallback.
- Locale changes are persisted through @sveltebase/state.
- Cookie initialization avoids a fallback-language flash during SSR and
  hydration.
- Message translation and Intl formatting are delegated to use-intl.
- The high-level API is designed for Svelte 5 context and runes.

## License

ISC
