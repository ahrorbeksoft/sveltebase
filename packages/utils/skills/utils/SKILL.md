---
name: utils
description: Use @sveltebase/utils browser cookies, createAsync keyed loading/error state, tryCatch toasts, timestamps, IDs, delays, and simple plural labels in Svelte 5. Use for utility behavior and its SSR/error-handling boundaries.
license: ISC
metadata:
  library: "@sveltebase/utils"
---

# Sveltebase utils

Import public helpers from `@sveltebase/utils`. See [the README](../../README.md)
for signatures. Svelte is a peer dependency; `svelte-sonner` is optional for toasts.
Mount its Toaster in the application's UI when toast rendering is wanted.

## Async actions

```ts
import { createAsync } from '@sveltebase/utils';

const save = createAsync(async (id: string) => {
  const response = await fetch(`/api/items/${id}`, { method: 'PUT' });
  if (!response.ok) throw new Error('Could not save');
  return { success: 'Saved' };
});

// Catch rejections at the action boundary.
await save.runWithKey(row.id, row.id);
// In markup: disabled={save.isLoading(row.id)}
```

The first `runWithKey` argument identifies loading state; remaining arguments go to
the wrapped function. `run` uses the global key. `isLoading()` checks only that key,
not whether any keyed action is active. Overlapping calls to the same key keep it
loading until every call finishes. Read `isLoading` and `.error` reactively.

Return `{ success: string }` for a success toast, `{ error: string }` for an error
toast, or void/null for silence. An `{ error }` result **does not** reject or set
`.error`. Thrown values are normalized to Error, saved in `.error`, and rethrown;
loading resets in finally. `.error` is shared across keys, not a per-row error map.
`fetch` does not throw for non-2xx statuses: check `response.ok` yourself.

`tryCatch(fn, { onError? })` shows toasts but swallows thrown errors. Use it only
when the caller does not need rejection propagation or action loading state.
`onError` may return `{ message, description? }` to customize the error toast.
Toasts load lazily in the browser; import/use on SSR does not show a toast.

## Cookies

`Cookies.get`, `.set`, and `.remove` wrap `document.cookie`. On the server they are
no-ops and `get` returns null: use SvelteKit `event.cookies` for SSR and auth cookies.
Values are strings; JSON serialization is the caller's responsibility.

`set` defaults to path `/`, SameSite Lax, and Secure on HTTPS. `expires` is in days;
zero expires immediately. SameSite None forces Secure. `remove` needs the same path
and domain used to create the cookie. Malformed encoded values return null; an empty
cookie value returns an empty string. These helpers cannot manage HTTP-only sessions.

## Small helpers

- `timestamps(false)` returns createdAt/updatedAt with the same millisecond;
  `timestamps(true)` returns updatedAt only.
- `wait(ms)` resolves after the delay.
- `createId()` returns a UUID-style identifier for application records.
- `pluralize(count, { zero?, one?, other })` has exact zero/one handling, not CLDR
  locale rules. String one/other labels get a numeric prefix; zero and function
  results are returned directly.

