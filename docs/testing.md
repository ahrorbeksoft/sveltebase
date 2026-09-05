# Toolchain and validation

Use Node 24 (`.node-version`) and Bun 1.4.2 (`packageManager`). Run `bun install --frozen-lockfile`. The original binary lockfile and working-tree diff were preserved locally in `.implementation` before migration to `bun.lock`.

The implementation registry review is recorded locally in `.implementation/dependency-metadata.json`. TypeScript stays on 6.0.3 because SvelteKit and svelte-check peers support 5/6; Vitest stays on 4.1.11 because Cloudflare's current Workers test plugin requires ^4.1.0. See [Cloudflare integration migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/) and [Vitest Svelte browser testing](https://vitest.dev/api/browser/svelte).

- `bun run test:unit`: pure and simulated-browser regression tests.
- `bun run test:integration`: fake-indexeddb storage and adapter integration tests.
- `bun run test:browser`: Svelte and real IndexedDB tests in Chromium.
- `bun run test:workers`: actual workerd Durable Object tests.
- `bun run test:e2e`: Playwright browser flows.
- `bun run test:coverage`: line/branch reports and minimum gates.
- `bun run check`, `bun run lint`, `bun run build`, `bun run deadcode`, `bun run package:validate`: type/component checks, formatting/static analysis, emitted artifacts, dead-code inventory and isolated packed consumers.

Install browser binaries with `bunx playwright install chromium` (CI also installs OS dependencies). Unit/storage tests use deterministic clocks and deferred promises; external identity-provider requests are mocked. Fixtures in `tests/support` are private and excluded from published packages. Never publish to test a release: use `release:verify` and the release scripts' dry-run mode.

## Verified implementation

On 2026-09-05 the full local `release:verify` command passed on Node 24.20.0 and
Bun 1.4.2: 215 tests across unit/integration, Workers, Chromium and Playwright,
all per-package coverage thresholds, checks, lint/formatting, Knip, builds, and
all five isolated packed-package consumers. Overall coverage was 90.14% lines
and 82.97% branches. See [plan-audit.md](./plan-audit.md) for evidence boundaries
and [dependencies.md](./dependencies.md) for the empty-directory frozen install.
