# @sveltebase/state

Validated, immutable Svelte 5 state with optional browser persistence.

```ts
import { z } from 'zod';
import { PersistentState } from '@sveltebase/state';

const theme = new PersistentState('theme', z.enum(['light', 'dark']), {
  initial: 'light',
});

theme.current = 'dark';
theme.set((current) => (current === 'dark' ? 'light' : 'dark'));
```

`initial` is required. Both assignment and `set` run through the same
synchronous Standard Schema validator. The exposed values are cloned and deeply
frozen, so nested mutation cannot silently bypass validation. Produce a new
value through `set` instead. Snapshots accept JSON-like plain objects and
arrays; mutable built-ins such as `Date`, `Map`, and `Set` are rejected.

By default, browser instances use a JSON cookie with `path: "/"`,
`sameSite: "Lax"`, and a one-year expiry. Configure it with `cookie`, inject a
`StatePersistence` implementation, or disable persistence with
`persistence: false`. State has no notification dependency.

```ts
const preferences = new PersistentState('preferences', preferencesSchema, {
  initial: { density: 'comfortable' },
  cookie: { expires: 30, sameSite: 'Strict' },
});

// Stop only the persistence effect. The state stays usable in memory.
preferences.dispose();
```

Storage read/write failures keep the validated in-memory value. Inspect
`persistenceError` or pass `onPersistenceError` to report them.

During SSR, instances must be request-scoped. Create them in request setup and
initialize from that request's cookies. `init` resets a missing or invalid
cookie to the instance's initial value, preventing values from an earlier
request from being retained.

```ts
const locale = new PersistentState('locale', localeSchema, { initial: 'en' });
locale.init(event.cookies.getAll());
```

`State` is the equivalent immutable in-memory holder when no validation or
persistence is needed.
