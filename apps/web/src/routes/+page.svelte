<script lang="ts">
  import { getFormat, getTranslations } from "@sveltebase/i18n";
  import { i18n } from "../lib/i18n";

  const t = getTranslations();
  const format = getFormat();

  function switchLocale(locale: (typeof i18n.languages)[number]["code"]) {
    i18n.locale = locale;
  }
</script>

<svelte:head>
  <title>Svelte Essentials i18n Example</title>
</svelte:head>

<div style="padding: 24px;">
  <h1>{t("app-title")}</h1>

  <p>{t("app-description")}</p>

  <p>
    <strong>{t("current-locale")}:</strong>
    {i18n.currentLanguage.label} ({i18n.currentLanguage.code})
  </p>

  <p>
    <strong>{t("format-demo")}:</strong>
    {format(new Date(), { preset: "full", withTime: true })}
  </p>

  <p>
    <strong>{t("async-demo")}:</strong>
    {format(Date.now() - 1000 * 60 * 5, { preset: "custom" })}
  </p>

  <div style="display: flex; gap: 12px;">
    {#each i18n.languages as language}
      <button
        type="button"
        disabled={i18n.currentLanguage.code === language.code}
        onclick={() => switchLocale(language.code)}
      >
        {language.label}
      </button>
    {/each}
  </div>
</div>
