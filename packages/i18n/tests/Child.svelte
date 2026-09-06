<script lang="ts">
  import { getTranslations, getFormat } from "../src/index.js";
  const t = getTranslations();
  const format = getFormat();
</script>
<p>{t("greeting", { name: "Ada" })}</p>
<time>{format("2020-01-15T12:00:00Z", { preset: "birthday" })}</time>
