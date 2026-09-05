# Static analysis inventory

The pre-implementation manifests, public subpaths, dependency graph and command
failures are preserved in [baseline.json](./baseline.json). The exact original
working-tree patch, binary Bun lockfile and source import inventory remain local
in `.implementation/`; the original seven manifest edits were preserved.

Knip treats published manifest subpaths as public API, Svelte components/rune
modules as compiler inputs, and test fixtures/configuration as private entry
points. It reports unlisted imports, unreachable files, unused exports and
unexplained dependencies. `cloudflare:workers` and `cloudflare:test` are runtime
built-ins, not npm packages. The `cloudflare` dependency-name exemption records
that resolution rule.

The optional SvelteKit, Vite and Wrangler peers are intentionally referenced
from their explicit integration entry points. Their optional-peer findings are
classified in `knip.json`; this does not ignore unlisted dependencies or unused
runtime dependencies. Isolated neutral and platform consumers separately verify
that unrelated entry points do not require those optional integrations.

Removed paths include Dexie interception/legacy mutation queues, the Instant
alias, flattened auth helpers, old i18n singleton/locale initialization helpers,
redundant notification loaders, duplicate HTML entry, and the ungated interactive
release wrapper. Historical sync policy suggestions are archived under
`docs/archive`. User-owned `continue.md` remains historical context.
