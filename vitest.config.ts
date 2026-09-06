import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

const alias = Object.fromEntries(["utils", "state", "i18n"].map((name) => [
  `@sveltebase/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))
]));

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["packages/{utils,state,i18n,auth}/src/**/*.ts", "packages/auth/src/**/*.svelte"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 }
    },
    projects: [
      {
        plugins: [svelte({ configFile: false })],
        resolve: { alias, conditions: ["browser"] },
        test: {
          name: "client",
          environment: "jsdom",
          environmentOptions: { jsdom: { url: "https://example.test/" } },
          include: ["packages/{utils,state,i18n,auth}/tests/**/*.client.test.ts", "packages/{utils,state,i18n,auth}/tests/**/*.client.test.svelte.ts"],
          setupFiles: ["./tests/setup-client.ts"],
          restoreMocks: true,
          unstubGlobals: true
        }
      },
      {
        plugins: [svelte({ configFile: false })],
        resolve: { alias, conditions: ["node"] },
        test: {
          name: "server",
          environment: "node",
          include: ["packages/{utils,state,i18n,auth}/tests/**/*.server.test.ts"],
          restoreMocks: true,
          unstubGlobals: true
        }
      }
    ]
  }
});
