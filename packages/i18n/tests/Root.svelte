<script lang="ts">
  import type { CreateI18nReturn } from "../src/index.js";
  import { languages } from "./catalog.js";
  import Child from "./Child.svelte";
  let { i18n, locale }: { i18n: CreateI18nReturn<typeof languages>; locale?: string | null | (() => string | null | undefined) } = $props();
  // Context is intentionally installed once during component initialization.
  // svelte-ignore state_referenced_locally
  i18n.init(() => typeof locale === "function" ? locale() : locale);
</script>
<Child />
