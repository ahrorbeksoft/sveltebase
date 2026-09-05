<script lang="ts">
  import { browser } from '$app/environment';
  import {
    createI18n,
    provideI18n,
    type LocaleStorage,
  } from '@sveltebase/i18n';
  import { languages } from '$lib/i18n';
  import '../app.css';
  import { untrack, type Snippet } from 'svelte';

  const { data, children } = $props<{
    data: { locale: (typeof languages)[number]['code'] };
    children: Snippet;
  }>();

  const localeStorage:
    LocaleStorage<(typeof languages)[number]['code']> | undefined = browser
    ? {
        get: () =>
          document.cookie
            .split('; ')
            .find((value) => value.startsWith('locale='))
            ?.slice('locale='.length),
        set: (locale) => {
          document.cookie = `locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
        },
      }
    : undefined;

  // This runs once per rendered layout. No mutable i18n state escapes to SSR module scope.
  const i18n = createI18n({
    languages,
    locale: untrack(() => data.locale),
    storage: localeStorage,
    timeZone: 'Asia/Tashkent',
  });
  provideI18n(i18n);
</script>

{@render children()}
