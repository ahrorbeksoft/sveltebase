# Dependency review

Reviewed 2026-09-05 against the committed `bun.lock`.

The final review parsed Bun's resolved package entries and submitted 444 distinct
package names and resolved versions to npm's bulk advisory endpoint. This checks
the lock graph rather than only direct manifests. `npm audit` cannot read a Bun
lockfile, and Bun's built-in scanner requires a separately configured scanner,
so neither was used as a substitute. The endpoint returned HTTP 200 with zero
advisories for the final graph.

## Findings

The initial advisory endpoint query reported eleven matches across five resolved
package versions. Root-level exact overrides updated the vulnerable copies to
their lowest compatible fixed versions. The final query of the regenerated lock
returned zero advisories.

| Resolved package  | Severity               | Dependency path                                | Finding                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cookie@0.6.0`    | low                    | `@sveltejs/kit@2.70.3`                         | [GHSA-pxg6-pf52-xh8x](https://github.com/advisories/GHSA-pxg6-pf52-xh8x): out-of-bounds characters in cookie name, path, or domain. This is reachable in the SvelteKit app runtime.                                                                                                                                                                                                  |
| `esbuild@0.27.4`  | low                    | `tsup@8.5.1`                                   | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr): Windows development-server file read. Build tooling only in this workspace.                                                                                                                                                                                                                                |
| `nanoid@3.3.11`   | high (3 advisories)    | `postcss@8.5.8`                                | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8), and [GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w): non-secure/custom generator denial of service and integer overflow. CSS tooling only.                                                              |
| `picomatch@4.0.3` | moderate, high         | `vitest@4.1.11` and nested `tinyglobby` copies | [GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p) and [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj): glob parsing method injection and ReDoS. Test/build tooling only.                                                                                                                                                             |
| `postcss@8.5.8`   | moderate (2), high (2) | resolved CSS-tooling copy                      | [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93), [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), and [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849): source-map path/file disclosure and CSS stringify XSS. CSS tooling only. |

The release lock pins the applicable fixed versions through root overrides:
`cookie@0.7.0`, `esbuild@0.28.1`, `nanoid@3.3.18`, `picomatch@4.0.4`, and
`postcss@8.5.28`. This avoids unnecessary major upgrades: all five support the
project's Node 24 runtime, and the override set is the smallest version set that
clears the reported vulnerable ranges.

## Reproducibility check

An empty temporary directory containing only the root `package.json`, every
workspace `package.json`, and the committed `bun.lock` completed:

```sh
npm exec --package=bun@1.4.2 -- bun install --frozen-lockfile
```

Bun 1.4.2 verified 332 installs across 471 packages without changes. This
confirms the lockfile resolves without the existing workspace `node_modules`.

## Required follow-up

Keep the overrides until upstream dependency ranges resolve to fixed versions on
their own. Regenerate `bun.lock` with Bun 1.4.2 after any dependency change, run
a frozen install, and repeat this lockfile-level check. Do not suppress future
findings with `skipLibCheck` or a scanner allowlist.
