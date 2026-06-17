# Sveltebase Workspace

A Bun workspace containing foundational Svelte 5 packages.

## Packages

- **[`@sveltebase/sync`](./packages/sync/README.md)**: Reactive, local-first database synchronization library using Dexie.js (IndexedDB) on the client, WebSocket multiplexing, and Cloudflare Durable Objects on the server.
- **[`@sveltebase/auth`](./packages/auth/README.md)**: Lightweight, Edge-native, DB-agnostic authentication library built for Svelte 5 and SvelteKit that integrates with `@sveltebase/sync` for real-time WebSocket session verification.
- **[`@sveltebase/utils`](./packages/utils/README.md)**: Svelte utility package with helpers for cookies, async flows, keyed async state helpers, and direct `svelte-sonner` toast notifications.
- **[`@sveltebase/state`](./packages/state/README.md)**: Svelte rune-based global state package.
- **[`@sveltebase/i18n`](./packages/i18n/README.md)**: Locale state, translation, and formatting helpers.
