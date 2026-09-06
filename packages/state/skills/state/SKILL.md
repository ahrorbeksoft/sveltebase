---
name: state
description: Use @sveltebase/state State and PersistentState for Svelte 5 reactive values, schema-validated cookie preferences, and SSR cookie hydration.
license: ISC
metadata:
  library: "@sveltebase/state"
---

# Sveltebase state

Import `State` and `PersistentState` from `@sveltebase/state`.
See [the package README](../../README.md) for the full API.

## Choose the storage

`new State(initialValue)` provides reactive `.current` and `.set(updater)` with no
persistence or validation. Use it for UI state. `PersistentState` stores small JSON
preferences in a browser-readable cookie.

```ts
import { State, PersistentState } from '@sveltebase/state';
import { z } from 'zod';

const count = new State(0);
count.set((value) => value + 1);

const theme = new PersistentState(
  'theme',
  z.enum(['light', 'dark']).default('light'),
);
theme.current = 'dark';
```

The schema must implement Standard Schema v1 with **synchronous** validation and
accept `undefined` to produce an initial/default value. Async validators are rejected.
Sveltebase does not require Zod specifically. Assignments and `.set` validate before
replacing the previous state. Schema outputs must remain acceptable on later writes
when using transforms.

Nested object edits react and persist but bypass validation. For validated updates,
return a new object: `state.set(value => ({ ...value, count: nextCount }))`.
Do not mutate `value` first: a failing validator cannot undo that earlier mutation.

## SSR and hydration

Construct mutable instances in a request/component scope to avoid cross-user SSR
state. Share schemas instead of mutable server instances. Initialize with only the
serialized cookie returned by SvelteKit:

```ts
// +layout.server.ts
export function load({ cookies }) {
  return { themeCookie: cookies.get('theme') };
}
```

In the component, construct the same theme state and call
`theme.init(() => data.themeCookie)`. The value is JSON text such as `'"dark"'`,
not `'dark'`, a parsed value, or the entire cookies object.

In the browser, construction reads `document.cookie`; `init` is a no-op. On the
server, `init` parses/validates its argument; absent or invalid data uses the schema
default. Do not use browser `Cookies.get` for server reads.

Create a persistent instance once and reuse it when reading or updating its value. Cookies use path `/`, SameSite Lax, a one-year lifetime,
and Secure on HTTPS. Keep values JSON-serializable, small, and non-sensitive.
