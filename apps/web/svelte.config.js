import adapter from "@sveltejs/adapter-auto";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "../..");

const config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    alias: {
      "@sveltebase/utils": path.resolve(workspaceRoot, "packages/utils/src/index.ts"),
      "@sveltebase/state": path.resolve(workspaceRoot, "packages/state/src/index.ts"),
      "@sveltebase/i18n": path.resolve(workspaceRoot, "packages/i18n/src/index.ts"),
      "@sveltebase/instant": path.resolve(workspaceRoot, "packages/instant/src/index.ts")
    }
  }
};

export default config;
