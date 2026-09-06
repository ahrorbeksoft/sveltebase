<script lang="ts">
  import { untrack } from "svelte";
  import type { CreateI18nReturn } from "../src/index.js";
  import { languages } from "./catalog.js";
  import Child from "./Child.svelte";
  let { i18n, locale, interleave }: { i18n: CreateI18nReturn<typeof languages>; interleave?: () => void; locale?: string | null | (() => string | null | undefined) } = $props();
  // Context is intentionally installed once during component initialization.
  // svelte-ignore state_referenced_locally
  i18n.init(() => typeof locale === "function" ? locale() : locale);
  untrack(() => interleave?.());
</script>
<Child />
<span data-locale>{i18n.locale}</span>
<span data-language>{i18n.currentLanguage.label}</span>
<span data-direct>{i18n.t("greeting", { name: "Ada" })}</span>
