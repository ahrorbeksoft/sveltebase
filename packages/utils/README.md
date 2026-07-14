# @sveltebase/utils

Small runtime helpers for Svelte 5 applications. The package contains browser
cookie utilities, reactive async action state, toast-aware error handling,
timestamps, delays, ids, and simple plural formatting.

## Install

```bash
bun add @sveltebase/utils
```

`svelte` is a peer dependency. Install `svelte-sonner` when you want the async
helpers to display toast notifications:

```bash
bun add svelte-sonner
```

## Exports

```ts
import {
  Cookies,
  createAsync,
  createId,
  pluralize,
  timestamps,
  tryCatch,
  wait,
  type CookieOptions,
  type TryCatchErrorToast,
  type TryCatchOptions,
  type TryCatchReturn
} from "@sveltebase/utils";
```

## `Cookies`

`Cookies` is a browser-only helper around `document.cookie`.

```ts
Cookies.set("theme", "dark", {
  expires: 30,
  path: "/",
  sameSite: "Lax"
});

const theme = Cookies.get("theme"); // string | null
Cookies.remove("theme");
```

### `CookieOptions`

```ts
interface CookieOptions {
  expires?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  partitioned?: boolean;
}
```

`expires` is a number of days from now. It is written as a `max-age` value.
When omitted, `set` uses `path: "/"`, `sameSite: "Lax"`, and sets `secure`
automatically when the current page uses HTTPS. `sameSite: "None"` always
forces the `secure` attribute. Cookie names and values are URI-encoded.

### `Cookies.set(name, value, options?)`

Writes a cookie and returns `void`.

```ts
Cookies.set("session_hint", "account@example.com", {
  path: "/login",
  domain: "example.com",
  expires: 7,
  secure: true,
  sameSite: "Strict",
  partitioned: true
});
```

On the server, this method is a no-op.

### `Cookies.get(name)`

Returns the decoded cookie value, or `null` when it does not exist. It also
returns `null` during SSR.

### `Cookies.remove(name, options?)`

Deletes a cookie by writing an empty value with a negative expiration. The
optional object accepts only `path` and `domain`; use the same path and domain
that were used when the cookie was created.

## `createAsync`

Wraps an async function with reactive loading state and an error value. The
wrapped function may return `TryCatchReturn` values:

```ts
type TryCatchReturn =
  | { success: string; error?: never }
  | { error: string; success?: never }
  | null
  | void;
```

Returning `{ success }` or `{ error }` displays the corresponding toast when
`svelte-sonner` is available in the browser. `null` and `void` finish silently.

```ts
const save = createAsync(async (name: string) => {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });

  return response.ok
    ? { success: "Profile saved" }
    : { error: "Could not save profile" };
});

await save.run("Ahror");
save.isLoading(); // global action state
save.error; // Error | null
```

The returned object has this API:

```ts
const action = createAsync(asyncFn);

action.run(...args);
action.runWithKey(key, ...args);
action.isLoading(key?);
action.error;
```

- `run(...args)` uses one global loading key.
- `runWithKey(key, ...args)` tracks an independent loading state for each key.
- `isLoading()` reads the global key; `isLoading("row-1")` reads a keyed state.
- An empty `runWithKey` key uses the global key.
- `error` contains the last thrown `Error`, or `null` until a task throws.
- A returned `{ error }` does not set `error` and does not reject the promise.
- A thrown error is stored, shown as a toast, and rethrown to the caller.
- Loading is reset to `false` when the task resolves or rejects.

Thrown errors show the error name and message in development and a generic
`Something went wrong` message in production. Toast loading is lazy and is
skipped safely during SSR.

## `tryCatch`

Runs one task and handles `TryCatchReturn` messages with the same toast rules as
`createAsync`.

```ts
await tryCatch(async () => {
  const response = await fetch("/api/invite", { method: "POST" });
  return response.ok
    ? { success: "Invite sent" }
    : { error: "Could not send invite" };
});
```

`tryCatch` catches thrown errors and does not rethrow them. Its signature is:

```ts
tryCatch(
  task: () => Promise<TryCatchReturn> | TryCatchReturn,
  options?: TryCatchOptions
): Promise<void>;
```

### `TryCatchOptions`

```ts
interface TryCatchOptions {
  onError?: (
    error: Error
  ) => TryCatchErrorToast | null | undefined | Promise<TryCatchErrorToast | null | undefined>;
}

type TryCatchErrorToast =
  | string
  | { message: string; description?: string };
```

`onError` runs only for thrown errors. Return a string or object for a custom
error toast. Return `undefined` or `null` to use the default development or
production message.

```ts
class SessionExpiredError extends Error {}

await tryCatch(
  () => loadPrivateData(),
  {
    onError(error) {
      if (error instanceof SessionExpiredError) {
        return {
          message: "Your session has expired",
          description: "Sign in again to continue."
        };
      }
    }
  }
);
```

## `timestamps(updateOnly)`

Returns millisecond timestamps from one `Date.now()` call:

```ts
const created = timestamps(false);
// { createdAt: number, updatedAt: number }

const updated = timestamps(true);
// { updatedAt: number }
```

The two fields returned for `timestamps(false)` are always equal.

## `wait(ms)`

Returns a promise that resolves after `ms` milliseconds.

```ts
await wait(250);
```

## `createId()`

Returns a UUID-like version 4 id. It uses `crypto.randomUUID()` first, then
`crypto.getRandomValues()`, and finally a `Math.random()` fallback when no Web
Crypto API is available.

```ts
const id = createId();
```

The fallback is useful for compatibility, but use a cryptographically secure
runtime when ids are security-sensitive.

## `pluralize(count, options)`

Formats a count using explicit zero, one, and other rules.

```ts
pluralize(0, { zero: "No items", one: "item", other: "items" });
// "No items"

pluralize(1, { one: "item", other: "items" });
// "1 item"

pluralize(4, { one: "item", other: "items" });
// "4 items"

pluralize(3, {
  other: (value) => `${value} matches found`
});
// "3 matches found"
```

```ts
pluralize(
  count: number,
  options: {
    zero?: string;
    one?: string;
    other: string | ((count: number) => string);
  }
): string;
```

`zero` is used only for `count === 0`. `one` is used only for `count === 1`
and is prefixed with `1 `. Every other count uses `other`, either as a noun or
as a callback result.

## SSR and toast behavior

- `Cookies.set` and `Cookies.remove` do nothing during SSR.
- `Cookies.get` returns `null` during SSR.
- `createAsync` and `tryCatch` still run their tasks during SSR, but toast
  notifications are skipped because they require a browser.
- `svelte-sonner` is imported lazily, so importing this package does not require
  a mounted `<Toaster />` or a browser at module-evaluation time.

## License

ISC
