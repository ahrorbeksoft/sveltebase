<script lang="ts">
  import { onMount } from 'svelte';
  import { createAuth } from '@sveltebase/auth/client';
  import { getFormat, getI18n, getTranslations } from '@sveltebase/i18n';
  import { State } from '@sveltebase/state';
  import {
    SyncClient,
    type SyncClient as SyncClientInstance,
  } from '@sveltebase/sync/client';
  import { createAsync, wait } from '@sveltebase/utils';
  import { languages } from '$lib/i18n';

  type DemoUser = { id: string; name: string };
  type DemoClaims = { role: 'demo' };
  type DemoTodo = { id: string; title: string; completed: boolean };

  const i18n = getI18n<typeof languages>();
  const t = getTranslations();
  const format = getFormat();
  const counter = new State(0);
  const action = createAsync(async () => {
    await wait(250);
    return { success: 'completed' };
  });
  const auth = createAuth<DemoUser, DemoClaims>({
    routesBase: '/demo/auth',
    fetch: async (input) => {
      const path = String(input);
      if (path.endsWith('/logout')) return new Response(null, { status: 204 });
      return Response.json({
        subject: 'demo-user',
        user: { id: 'demo-user', name: 'Demo user' },
        claims: { role: 'demo' },
      });
    },
  });
  let actionResult = $state('');
  let ready = $state(false);
  let offlineSync = $state<SyncClientInstance<{ todos: DemoTodo }> | null>(
    null,
  );
  let pendingMutations = $state(0);

  auth.init(null);
  onMount(() => {
    const sync = new SyncClient<{ todos: DemoTodo }>({
      name: 'sveltebase-demo',
      accountId: 'demo-user',
      url: '/api/sync',
      autoStart: false,
      tables: { todos: { indexes: 'id, completed', channel: 'todos' } },
    });
    offlineSync = sync;
    ready = true;
    return () => sync.dispose();
  });

  function switchLocale(locale: (typeof languages)[number]['code']) {
    i18n.locale = locale;
  }

  async function runAction() {
    const result = await action.run();
    actionResult = result?.success ?? '';
  }

  async function loginDemo() {
    await auth.login({ source: 'web-demo' });
  }

  async function queueOfflineMutation() {
    if (!offlineSync) return;
    const receipt = await offlineSync.create('todos', {
      id: crypto.randomUUID(),
      title: 'Offline demo item',
      completed: false,
    });
    await receipt.local;
    pendingMutations = offlineSync.pendingMutationCount;
  }
</script>

<svelte:head>
  <title>Svelte Essentials i18n Example</title>
</svelte:head>

<main data-ready={ready}>
  <header>
    <h1>{t('app-title')}</h1>
    <p>{t('app-description')}</p>
    <div class="locale-picker" aria-label={t('language')}>
      {#each i18n.languages as language (language.code)}
        <button
          type="button"
          aria-pressed={i18n.currentLanguage.code === language.code}
          disabled={i18n.currentLanguage.code === language.code}
          onclick={() => switchLocale(language.code)}
        >
          {language.label}
        </button>
      {/each}
    </div>
  </header>

  <section>
    <h2>{t('i18n-title')}</h2>
    <p>{t('i18n-description')}</p>
    <dl>
      <div>
        <dt>{t('current-locale')}</dt>
        <dd>{i18n.currentLanguage.label} ({i18n.currentLanguage.code})</dd>
      </div>
      <div>
        <dt>{t('format-demo')}</dt>
        <dd>{format(new Date(), { preset: 'full', withTime: true })}</dd>
      </div>
      <div>
        <dt>{t('async-demo')}</dt>
        <dd>{format(Date.now() - 1000 * 60 * 5, { preset: 'relative' })}</dd>
      </div>
    </dl>
  </section>

  <section>
    <h2>{t('state-title')}</h2>
    <p>{t('state-description')}</p>
    <h3>{t('state-demo-title')}</h3>
    <p aria-live="polite">{t('counter')}: {counter.current}</p>
    <div class="actions">
      <button type="button" onclick={() => counter.set((value) => value - 1)}
        >{t('decrement')}</button
      >
      <button type="button" onclick={() => counter.set((value) => value + 1)}
        >{t('increment')}</button
      >
      <button type="button" onclick={() => (counter.current = 0)}
        >{t('reset')}</button
      >
    </div>
  </section>

  <section>
    <h2>{t('sync-title')}</h2>
    <p>{t('sync-description')}</p>
    <p>{t('sync-offline-note')}</p>
    <button
      type="button"
      disabled={!offlineSync}
      onclick={queueOfflineMutation}
    >
      {t('sync-queue-mutation')}
    </button>
    <p aria-live="polite">{t('sync-pending')}: {pendingMutations}</p>
  </section>

  <section>
    <h2>{t('utils-title')}</h2>
    <p>{t('utils-description')}</p>
    <h3>{t('utils-demo-title')}</h3>
    <button type="button" disabled={action.isLoading()} onclick={runAction}>
      {action.isLoading() ? t('running') : t('run-action')}
    </button>
    <p aria-live="polite">{actionResult ? actionResult : t('async-idle')}</p>
  </section>

  <section>
    <h2>{t('auth-title')}</h2>
    <p>{t('auth-description')}</p>
    <p>{t('auth-demo-note')}</p>
    {#if auth.isAuthenticated}
      <p aria-live="polite">{t('auth-signed-in')}: {auth.user?.name}</p>
      <button type="button" onclick={() => auth.logout()}
        >{t('auth-logout')}</button
      >
    {:else}
      <p aria-live="polite">{t('auth-signed-out')}</p>
      <button type="button" onclick={loginDemo}>{t('auth-login')}</button>
    {/if}
  </section>
</main>
