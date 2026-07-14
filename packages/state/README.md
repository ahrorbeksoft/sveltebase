# @sveltebase/state

Reactive state for Svelte 5 — plain values in memory, or values that stick around in a cookie.

## Install

```bash
bun add @sveltebase/state svelte
```

For cookie-backed state you’ll also want a schema library (Zod, Valibot, etc.):

```bash
bun add zod
```

## In-memory state

```ts
import { State } from "@sveltebase/state";

const count = new State(0);

count.current;      // 0
count.current = 1;  // set directly
count.set((n) => n + 1); // or update from the previous value
```

That’s it. `current` is reactive, so Svelte will re-render when it changes.

## Cookie-backed state

`PersistentState` keeps a value in a cookie and validates it with any [Standard Schema](https://standardschema.dev/) library (Zod works out of the box).

```ts
import { z } from "zod";
import { PersistentState } from "@sveltebase/state";

const theme = new PersistentState(
  "theme",
  z.enum(["light", "dark"]).default("light")
);

theme.current; // "light" | "dark"
theme.current = "dark";
theme.set((t) => (t === "dark" ? "light" : "dark"));
```

- The first argument is the cookie name.
- The schema defines the shape and the default (via `.default(...)`).
- Invalid values are rejected; the previous value stays put.

In the browser the cookie is read on construction and written on every change. Cookies use `path: "/"`, `sameSite: "Lax"`, a one-year lifetime, and `secure` on HTTPS.

## SvelteKit setup

So SSR and the browser start with the same value, pass request cookies into `init`.

**`src/routes/+layout.server.ts`**

```ts
export function load({ cookies }) {
  return { cookies: cookies.getAll() };
}
```

**`src/lib/state.ts`**

```ts
import { z } from "zod";
import { PersistentState } from "@sveltebase/state";

export const locale = new PersistentState(
  "locale",
  z.enum(["en", "uz"]).default("en")
);
```

**`src/routes/+layout.svelte`**

```svelte
<script lang="ts">
  import { locale } from "$lib/state";

  let { data } = $props();
  locale.init(() => data.cookies);
</script>

{@render children()}
```

You can pass the cookie list directly or as a function — use a function when the data comes from reactive load props.

`init` does nothing in the browser. On the server it finds the matching cookie, parses the JSON, validates it, and sets the value. Missing or invalid cookies fall back to the schema default.

## How cookies behave

| Situation | What happens |
| --- | --- |
| Browser, cookie present | Hydrates from `document.cookie` |
| Browser, cookie missing/invalid | Uses the schema default |
| Server, before `init` | Uses the schema default |
| Server, after `init` | Uses the request cookie (or default if missing) |
| Invalid write via `current` | Throws; old value is kept |

Values are stored as JSON. Older URI-encoded cookies are still accepted.

## License

ISC
