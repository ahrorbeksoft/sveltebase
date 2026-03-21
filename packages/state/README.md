# `@sveltebase/state`

Small state helpers for Svelte 5.

This package exports two classes:

- `State<T>`: simple reactive in-memory state
- `PersistentState<TSchema>`: reactive state backed by cookies and validated with `zod`

## Install

~~~bash
bun add @sveltebase/state zod svelte
~~~

## Exports

- `State`
- `PersistentState`

## `State`

A tiny wrapper around a value.

~~~ts
import { State } from "@sveltebase/state";

const count = new State(0);

count.current = 1;
count.set((value) => value + 1);

console.log(count.current); // 2
~~~

### API

- `new State(initialValue)`
- `state.current`
- `state.set(updater)`

## `PersistentState`

Cookie-backed state with schema validation.

It:

- reads from cookies
- validates with `zod`
- writes updates back to cookies
- can load the initial value during SSR

~~~ts
import { z } from "zod";
import { PersistentState } from "@sveltebase/state";

const themeSchema = z.enum(["light", "dark"]).default("light");

export const theme = new PersistentState("theme", themeSchema);

theme.current = "dark";
theme.set((value) => (value === "dark" ? "light" : "dark"));
~~~

## SSR setup

For SSR, return all cookies from `+layout.server.ts`, then initialize the state with `state.init(() => data.cookies)` so it loads the server value first.

### `src/routes/+layout.server.ts`

~~~ts
export async function load({ cookies }) {
  return {
    cookies: cookies.getAll()
  };
}
~~~

### `src/routes/+layout.svelte`

~~~svelte
<script lang="ts">
  import type { LayoutData } from "./$types";
  import { locale } from "$lib/state";

  let { data }: { data: LayoutData } = $props();

  locale.init(() => data.cookies);
</script>

<slot />
~~~

### `src/lib/state.ts`

~~~ts
import { z } from "zod";
import { PersistentState } from "@sveltebase/state";

export const locale = new PersistentState(
  "locale",
  z.enum(["en", "uz"]).default("en")
);
~~~

With this setup:

- on the server, `init` reads from `data.cookies`
- the initial SSR render uses that cookie value
- in the browser, updates keep syncing back to cookies

## API

### `new PersistentState(key, schema)`

Creates a persistent state value.

- `key`: cookie name
- `schema`: `zod` schema for parsing and validation

### `persistentState.current`

Gets or sets the current value.

### `persistentState.set(updater)`

Updates the current value.

### `persistentState.init(cookies)`

Loads the value from server cookies.

It accepts either:

- a cookie array
- a getter function like `() => data.cookies`

Expected cookie shape:

~~~ts
type Cookie = {
  name: string;
  value: string;
};
~~~

## Notes

- `PersistentState` stores JSON in cookies
- invalid cookie data falls back to the schema result
- `init(...)` is for server-side initialization
- this package is designed for Svelte 5
