# @sveltebase/utils

Small framework-neutral helpers plus reactive Svelte async state. Cookie and
notification code is separate: importing cookies does not load a toast library.

## Cookies

```ts
import { Cookies, createCookieStore } from '@sveltebase/utils';

Cookies.set('theme', 'dark', { expires: 30, sameSite: 'Lax' });
Cookies.get('theme'); // "dark" | null
Cookies.remove('theme', { path: '/' });
```

Cookie names use exact parsing, malformed URI encoding is ignored, `expires: 0`
immediately expires the cookie, and removal retains the supplied path/domain.
`createCookieStore(documentLike)` supports tests and embedded environments.

## Async actions and notifications

Install an application-owned adapter once. Adapter failures never change an
operation's return value or thrown error.

```ts
import { createAsync, setNotificationAdapter } from '@sveltebase/utils';
import { toast } from 'svelte-sonner';

setNotificationAdapter({
  success: ({ message }) => toast.success(message),
  error: ({ message, description }) => toast.error(message, { description }),
});

const save = createAsync(async (name: string) => {
  await api.save(name);
  return { success: 'Saved' };
});
```

`run` uses a global key. `runWithKey(key, ...)` tracks independent actions.
Concurrent calls for the same key increment `pendingCount`; the key is removed
after all calls finish. `error` belongs to the most recently started call, so a
late failure cannot overwrite a later result. Declared `{ success }` and
`{ error }` results resolve; thrown errors are stored and rethrown.

`tryCatch` is for one-off work. It returns the declared result and converts a
thrown error into `undefined` after notification. Pass `notifications` to use a
per-call adapter, or `onError` to choose its message.

## Other helpers

`timestamps(true | false)` obtains create/update timestamps from one clock
reading. `wait(milliseconds)` rejects invalid durations. `createId()` creates a
UUID v4 using platform crypto when available. `pluralize` formats explicit
zero, singular, and plural forms.
