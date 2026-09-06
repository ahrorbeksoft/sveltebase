---
name: sveltebase
description: Use Sveltebase packages in Svelte 5 and SvelteKit applications. Choose the package for authentication, reactive state, translations, or utilities and load its usage skill.
license: ISC
---

# Using Sveltebase

| Task | Package | Intent skill |
| --- | --- | --- |
| Signed cookie sessions, auth routes, reactive auth, Google/Telegram login | `@sveltebase/auth` | `@sveltebase/auth#auth` |
| In-memory reactive values or small cookie-backed preferences | `@sveltebase/state` | `@sveltebase/state#state` |
| Locale persistence, ICU messages, localized date labels | `@sveltebase/i18n` | `@sveltebase/i18n#i18n` |
| Browser cookies, async loading/toasts, IDs, timestamps, plural labels | `@sveltebase/utils` | `@sveltebase/utils#utils` |

## Load package usage instructions

Run the command for the package you are using:

```sh
npx @tanstack/intent load '@sveltebase/auth#auth'
npx @tanstack/intent load '@sveltebase/state#state'
npx @tanstack/intent load '@sveltebase/i18n#i18n'
npx @tanstack/intent load '@sveltebase/utils#utils'
```

## Package entry points

- Auth: `createServerAuth` from `@sveltebase/auth/server`, `createAuthRoutes` from
  `@sveltebase/auth/sveltekit`, and `createAuth` from `@sveltebase/auth/client`.
- State: `State` and `PersistentState` from `@sveltebase/state`.
- Translations: `createI18n`, `getTranslations`, and `getFormat` from `@sveltebase/i18n`.
- Utilities: `Cookies`, `createAsync`, `tryCatch`, `timestamps`, `wait`, `createId`,
  and `pluralize` from `@sveltebase/utils`.
