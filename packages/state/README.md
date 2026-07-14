# @sveltebase/state

Small Svelte 5 rune-based state primitives. The package provides an in-memory
reactive value and a cookie-backed reactive value with Standard Schema
validation.

## Install

```bash
bun add @sveltebase/state svelte
```

`PersistentState` accepts any validator that implements the synchronous part of
Standard Schema v1. For example:

```bash
bun add zod
```

## Exports

```ts
import {
  PersistentState,
  State,
  type InferInput,
  type InferOutput,
  type MaybeGetter,
  type StandardSchemaV1
} from "@sveltebase/state";
```

## `MaybeGetter<T>`

```ts
type MaybeGetter<T> = T | (() => T);
```

Methods that accept `MaybeGetter` can receive a value directly or a getter that
is evaluated when the method runs. Passing a Svelte getter is useful when the
value comes from layout data.

## `State<T>`

`State` is a reactive in-memory value holder.

```ts
const count = new State(0);

count.current = 1;
count.set((value) => value + 1);

console.log(count.current); // 2
```

### API

#### `new State(initialValue)`

Creates a state value with `initialValue`.

#### `state.current`

Reactive getter and setter for the current value.

```ts
const name = new State("Ada");
name.current = "Grace";
const value: string = name.current;
```

#### `state.set(updater)`

Replaces the value with the result of an updater callback.

```ts
count.set((previous) => previous + 1);
```

The updater receives the current value and must return the next value.

## `StandardSchemaV1`

`PersistentState` uses this minimal Standard Schema shape:

```ts
interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<{ readonly message: string }> }
        >;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}
```

The runtime validator must be synchronous. If `validate` returns a promise,
`PersistentState` throws because cookie hydration and Svelte state updates are
synchronous.

### `InferInput<TSchema>` and `InferOutput<TSchema>`

These helpers extract the input and parsed output types from a schema:

```ts
type InferInput<TSchema extends StandardSchemaV1> = ...;
type InferOutput<TSchema extends StandardSchemaV1> = ...;
```

Use `InferOutput` when declaring values read from `current` and `InferInput`
when a schema library distinguishes accepted input from parsed output.

## `PersistentState<TSchema>`

`PersistentState` stores JSON in a browser cookie and validates values with a
Standard Schema-compatible schema.

```ts
import { z } from "zod";
import { PersistentState } from "@sveltebase/state";

const themeSchema = z.enum(["light", "dark"]).default("light");
export const theme = new PersistentState("theme", themeSchema);

theme.current = "dark";
theme.set((value) => (value === "dark" ? "light" : "dark"));
```

### `new PersistentState(key, schema)`

- `key` is the browser cookie name.
- `schema` validates hydrated cookie data and values assigned through
  `current`.
- The initial value is produced by validating `undefined`, so schemas with
  defaults are the usual way to define a fallback.

In the browser, the constructor reads the existing cookie immediately. Missing
or invalid cookie data falls back to the schema result for `undefined`.

### `persistentState.current`

Gets the parsed `InferOutput<TSchema>` value.

Assigning to `current` validates and parses the new value before storing it:

```ts
theme.current = "dark";
```

If validation returns issues, the assignment throws and the old value remains.

### `persistentState.set(updater)`

Passes the current parsed value to an updater and stores the returned value:

```ts
theme.set((current) => (current === "dark" ? "light" : "dark"));
```

The updater result is assigned directly. Use `current = ...` when the result
must go through schema parsing explicitly.

### `persistentState.init(cookies)`

Initializes the state from server-provided cookies during SSR.

```ts
type Cookie = { name: string; value: string };

state.init(cookies: Cookie[] | (() => Cookie[]));
```

`init` is a no-op in the browser. It searches for the configured cookie name,
decodes its JSON value, validates it, and updates the state. If the cookie is
missing, it validates `undefined`. A getter is evaluated lazily, which makes
this pattern work with SvelteKit load data:

```svelte
<script lang="ts">
  import { locale } from "$lib/state";

  let { data } = $props();
  locale.init(() => data.cookies);
</script>

<slot />
```

## SvelteKit SSR setup

Return cookies from a server layout so the first SSR render uses the same value
that the browser will hydrate:

`src/routes/+layout.server.ts`

```ts
export function load({ cookies }) {
  return { cookies: cookies.getAll() };
}
```

`src/lib/state.ts`

```ts
import { z } from "zod";
import { PersistentState } from "@sveltebase/state";

const localeSchema = z.enum(["en", "uz"]).default("en");
export const locale = new PersistentState("locale", localeSchema);
```

`src/routes/+layout.svelte`

```svelte
<script lang="ts">
  import { locale } from "$lib/state";

  let { data } = $props();
  locale.init(() => data.cookies);
</script>

<slot />
```

The browser writes every reactive value change back to the cookie with JSON,
`path: "/"`, `sameSite: "Lax"`, and a one-year `max-age`. The cookie helper
adds `secure` automatically on HTTPS.

## Cookie and runtime behavior

- SSR construction validates `undefined` until `init` receives request cookies.
- Browser construction hydrates from `document.cookie`.
- Stored values are JSON. URI-encoded JSON from older cookie writers is also
  accepted.
- Invalid browser cookie data is discarded and replaced with the schema result
  for `undefined`.
- Failed SSR initialization logs a warning and keeps the current value.
- Async schemas are not supported at runtime.
- State is reactive because the classes use Svelte 5 runes internally.

## License

ISC
