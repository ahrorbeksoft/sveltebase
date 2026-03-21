# `@sveltebase/state`

Small rune-friendly state helpers for Svelte 5.

This package provides two classes:

- `State<T>` for simple in-memory reactive state
- `PersistentState<TSchema>` for validated state that is persisted in cookies using `zod`

## Install

```bash
bun add @sveltebase/state zod
```

You also need `svelte` as a peer dependency:

```bash
bun add svelte
```

## What it exports

- `State`
- `PersistentState`

## `State`

Use `State` when you want a tiny reactive wrapper around a value.

### Example

```ts
import { State } from "@sveltebase/state";

const counter = new State(0);

counter.current = 1;
counter.set((value) => value + 1);

console.log(counter.current); // 2
```

### API

#### `new State(initialValue)`

Creates a new reactive state container.

#### `state.current`

Gets or sets the current value.

#### `state.set(updater)`

Updates the current value using a callback.

## `PersistentState`

Use `PersistentState` when you want state that:

- is validated with `zod`
- hydrates from cookies in the browser
- can be initialized from request cookies during SSR
- writes changes back to cookies automatically

## Install requirements

`PersistentState` depends on `zod`, so make sure it is installed:

```bash
bun add zod
```

## Example

```ts
import { z } from "zod";
import { PersistentState } from "@sveltebase/state";

const themeSchema = z.enum(["light", "dark"]).default("light");

export const theme = new PersistentState("theme", themeSchema);

// read
console.log(theme.current);

// write
theme.current = "dark";

// update
theme.set((value) => (value === "dark" ? "light" : "dark"));
```

## SSR usage

When rendering on the server, you can initialize the state from cookies before using it.

```ts
import { z } from "zod";
import { PersistentState } from "@sveltebase/state";

const localeSchema = z.enum(["en", "uz"]).default("en");

export const locale = new PersistentState("locale", localeSchema);

// for example, from a server load or request context:
locale.init([
  { name: "locale", value: "\"uz\"" }
]);

console.log(locale.current); // "uz"
```

## How persistence works

`PersistentState` stores the current value in a cookie using the key you pass to the constructor.

- On the client, it reads the cookie during hydration
- On updates, it writes the new value back to the cookie
- On the server, you can call `init(cookies)` to sync the initial value from request cookies

The stored cookie value is JSON-encoded and validated with your `zod` schema.

## API

### `new PersistentState(key, schema)`

Creates a persistent reactive state value.

- `key`: cookie name
- `schema`: `zod` schema used to validate and parse the value

### `persistentState.current`

Gets or sets the parsed current value.

### `persistentState.set(updater)`

Updates the current value using a callback.

### `persistentState.init(cookies)`

Initializes the state from server-side cookies.

Expected shape:

```ts
type Cookie = {
  name: string;
  value: string;
};
```

## Example with Svelte

```svelte
<script lang="ts">
  import { z } from "zod";
  import { State, PersistentState } from "@sveltebase/state";

  const count = new State(0);
  const locale = new PersistentState("locale", z.enum(["en", "uz"]).default("en"));

  function increment() {
    count.set((value) => value + 1);
  }

  function toggleLocale() {
    locale.current = locale.current === "en" ? "uz" : "en";
  }
</script>

<button onclick={increment}>
  Count: {count.current}
</button>

<button onclick={toggleLocale}>
  Locale: {locale.current}
</button>
```

## Notes

- `PersistentState` uses cookies for persistence
- values are validated with `zod` before being accepted
- if cookie data is invalid, the schema fallback/default is used
- this package is designed for Svelte 5
