# `@sveltebase/utils`

Utility helpers for Svelte 5 apps, with small primitives for cookies, async actions, timestamps, waiting, and toast-friendly error handling.

## Install

With Bun:

```bash
bun add @sveltebase/utils
```

If you want toast notifications from `createAsync` or `tryCatch`, also install `svelte-sonner`:

```bash
bun add svelte-sonner
```

> `svelte` is a peer dependency and should already exist in your app.

## What’s included

- `Cookies` — browser cookie helpers
- `createAsync` — wraps async functions with loading and error state
- `tryCatch` — run a task with built-in toast/error handling
- `timestamps` — generate `createdAt` / `updatedAt` values
- `wait` — simple promise-based delay helper
- `TryCatchReturn` — shared return type for async helpers

## Exports

```ts
import {
  Cookies,
  createAsync,
  timestamps,
  tryCatch,
  wait,
  type TryCatchReturn
} from "@sveltebase/utils";
```

---

## `Cookies`

A small browser-only cookie helper with `set`, `get`, and `remove`.

### Example

```ts
import { Cookies } from "@sveltebase/utils";

Cookies.set("theme", "dark", {
  path: "/",
  sameSite: "Lax",
  expires: 30
});

const theme = Cookies.get("theme");

Cookies.remove("theme");
```

### API

#### `Cookies.set(name, value, options?)`

Sets a cookie.

Options:

- `expires?: number` — number of days
- `path?: string`
- `domain?: string`
- `secure?: boolean`
- `sameSite?: "Lax" | "Strict" | "None"`
- `partitioned?: boolean`

#### `Cookies.get(name)`

Returns the cookie value as `string | null`.

#### `Cookies.remove(name, options?)`

Removes a cookie by setting an expired value.

---

## `createAsync`

Wraps an async function and gives you:

- loading state
- last thrown error
- optional success/error toasts

Your async function can return:

- `{ success: string }`
- `{ error: string }`
- `null`
- `void`

### Example

```ts
import { createAsync } from "@sveltebase/utils";

const saveProfile = createAsync(async (name: string) => {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    return { error: "Failed to save profile" };
  }

  return { success: "Profile saved" };
});

await saveProfile.run("Ahror");

console.log(saveProfile.isLoading());
console.log(saveProfile.error);
```

### Keyed loading states

Use `runWithKey` when you want separate loading states for multiple actions.

```ts
import { createAsync } from "@sveltebase/utils";

const removeItem = createAsync(async (id: string) => {
  const response = await fetch(`/api/items/${id}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    return { error: "Delete failed" };
  }

  return { success: "Item removed" };
});

await removeItem.runWithKey("item-42", "42");

const isDeleting = removeItem.isLoading("item-42");
```

### API

```ts
const task = createAsync(asyncFn);

task.run(...args);
task.runWithKey(key, ...args);
task.isLoading(key?);
task.error;
```

### Notes

- Toasts are shown with `svelte-sonner` when available in the browser.
- In development, thrown errors are also logged to the console.
- On the server, toast behavior is skipped safely.

---

## `tryCatch`

Runs a task and handles success/error messages in a consistent way.

### Example

```ts
import { tryCatch } from "@sveltebase/utils";

await tryCatch(async () => {
  const response = await fetch("/api/invite", { method: "POST" });

  if (!response.ok) {
    return { error: "Could not send invite" };
  }

  return { success: "Invite sent" };
});
```

### Throwing errors

```ts
import { tryCatch } from "@sveltebase/utils";

await tryCatch(async () => {
  const response = await fetch("/api/private");

  if (response.status === 401) {
    throw new Error("Unauthorized");
  }

  return { success: "Loaded" };
});
```

---

## `timestamps`

Creates timestamp objects using `Date.now()`.

### Example

```ts
import { timestamps } from "@sveltebase/utils";

const created = timestamps(false);
// { createdAt: 1712345678901, updatedAt: 1712345678901 }

const updated = timestamps(true);
// { updatedAt: 1712345678901 }
```

### Common usage

```ts
import { timestamps } from "@sveltebase/utils";

const post = {
  id: crypto.randomUUID(),
  title: "Hello",
  ...timestamps(false)
};
```

---

## `wait`

Returns a promise that resolves after the given number of milliseconds.

### Example

```ts
import { wait } from "@sveltebase/utils";

await wait(500);
console.log("Done");
```

Useful for:

- delaying UI transitions
- retry flows
- testing async behavior

---

## `TryCatchReturn`

A shared type for functions used with `createAsync` and `tryCatch`.

```ts
import type { TryCatchReturn } from "@sveltebase/utils";

async function submitForm(): Promise<TryCatchReturn> {
  return { success: "Submitted" };
}
```

Possible values:

```ts
type TryCatchReturn =
  | { success: string; error?: never }
  | { error: string; success?: never }
  | null
  | void;
```

---

## Svelte example

```svelte
<script lang="ts">
  import { createAsync } from "@sveltebase/utils";

  let name = $state("");

  const save = createAsync(async (value: string) => {
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: value })
    });

    if (!response.ok) {
      return { error: "Could not save profile" };
    }

    return { success: "Profile saved" };
  });
</script>

<input bind:value={name} placeholder="Your name" />

<button onclick={() => save.run(name)} disabled={save.isLoading()}>
  {save.isLoading() ? "Saving..." : "Save"}
</button>

{#if save.error}
  <p>{save.error.message}</p>
{/if}
```

## Notes

- `Cookies` works only in the browser.
- `createAsync` and `tryCatch` integrate with `svelte-sonner` if it is installed.
- The package is designed for Svelte 5 projects.

## License

ISC
