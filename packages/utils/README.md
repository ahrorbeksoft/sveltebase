# @sveltebase/utils

Small helpers for Svelte 5 apps: cookies, async actions with loading state, toasts, ids, delays, and simple plural formatting.

## Install

```bash
bun add @sveltebase/utils
```

`svelte` is a peer dependency. For toast notifications from the async helpers, also install:

```bash
bun add svelte-sonner
```

## Cookies

Browser-only helpers around `document.cookie`. On the server they are no-ops (`get` returns `null`).

```ts
import { Cookies } from "@sveltebase/utils";

Cookies.set("theme", "dark", {
  expires: 30, // days
  path: "/",
  sameSite: "Lax"
});

Cookies.get("theme");  // "dark" | null
Cookies.remove("theme");
```

Malformed encoded cookie values return `null`; empty cookie values return `""`. `expires: 0` expires the cookie immediately.

Defaults when options are omitted: `path: "/"`, `sameSite: "Lax"`, and `secure` when the page is HTTPS. `sameSite: "None"` always sets `secure`.

`remove` accepts optional `path` and `domain` — use the same ones you used when setting the cookie.

## Async actions

`createAsync` wraps an async function with reactive loading and error state.

```ts
import { createAsync } from "@sveltebase/utils";

const save = createAsync(async (name: string) => {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });

  // Optional: return a toast message
  return response.ok
    ? { success: "Profile saved" }
    : { error: "Could not save profile" };
});

await save.run("Ahror");
save.isLoading(); // true while the request is in flight
save.error;       // last thrown Error, or null
```

Return values:

- `{ success: "..." }` — success toast (if `svelte-sonner` is available)
- `{ error: "..." }` — error toast; does **not** set `save.error` or reject
- `null` / `void` — finishes quietly
- thrown error — stored on `save.error`, shown as a toast, and rethrown

### Multiple concurrent actions

Track loading per item with a key:

```ts
await save.runWithKey(rowId, "New name");
save.isLoading(rowId); // only that row
save.isLoading();      // the shared “global” key
```

Overlapping calls using the same key keep loading active until every call finishes. An empty key uses the shared global key.

### One-off try/catch with toasts

```ts
import { tryCatch } from "@sveltebase/utils";

await tryCatch(async () => {
  const response = await fetch("/api/invite", { method: "POST" });
  return response.ok
    ? { success: "Invite sent" }
    : { error: "Could not send invite" };
});
```

Unlike `createAsync`, `tryCatch` swallows thrown errors (and still toasts them). Customize the toast:

```ts
await tryCatch(() => loadPrivateData(), {
  onError(error) {
    if (error instanceof SessionExpiredError) {
      return {
        message: "Your session has expired",
        description: "Sign in again to continue."
      };
    }
    // return null/undefined for the default message
  }
});
```

Toasts are browser-only and load lazily — SSR is fine, and you don’t need a `<Toaster />` mounted at import time.

## Other helpers

### `timestamps`

```ts
timestamps(false); // { createdAt, updatedAt } — same millisecond
timestamps(true);  // { updatedAt }
```

### `wait`

```ts
await wait(250); // resolves after 250ms
```

### `createId`

```ts
const id = createId(); // UUID v4-style
```

Uses `crypto.randomUUID()` when available, then `getRandomValues()`, then a `Math.random()` fallback.

### `pluralize`

```ts
pluralize(0, { zero: "No items", one: "item", other: "items" });
// "No items"

pluralize(1, { one: "item", other: "items" });
// "1 item"

pluralize(4, { one: "item", other: "items" });
// "4 items"

pluralize(3, { other: (n) => `${n} matches found` });
// "3 matches found"
```

- `zero` — only when count is `0`
- `one` — only when count is `1` (prefixed with `1 `)
- `other` — everything else (string or function)

## License

ISC

## Agent skills (TanStack Intent)

This package ships its own skill and a shared Sveltebase overview. From your app:

```sh
npx @tanstack/intent@latest install
npx @tanstack/intent@latest list
npx @tanstack/intent@latest load '@sveltebase/utils#sveltebase'
npx @tanstack/intent@latest load '@sveltebase/utils#utils'
```

Select this package during Intent's first-time permission review. The skills come
from your installed package version; older releases may not include them.
