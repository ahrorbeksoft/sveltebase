<script lang="ts">
  import { untrack } from 'svelte';
  import { createI18n, getI18n, provideI18n } from './src/index.js';
  import type { I18nInstance, LanguageDefinition } from './src/index.js';

  let {
    languages,
    locale,
    capture,
  }: {
    languages: readonly LanguageDefinition[];
    locale: string;
    capture: (i18n: I18nInstance<readonly LanguageDefinition[]>) => void;
  } = $props();

  const supplied = untrack(() => createI18n({ languages, locale }));
  provideI18n(supplied);
  untrack(() => capture(getI18n()));
</script>

<p>{supplied.t('just-now')}</p>
