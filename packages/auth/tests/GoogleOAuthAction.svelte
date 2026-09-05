<script lang="ts">
  import { createGoogleLogin } from '../src/google/google.svelte.js';
  import { untrack } from 'svelte';
  import type {
    CodeResponse,
    NonOAuthError,
    TokenResponse,
  } from '../src/google/types.js';

  let {
    flow,
    onSuccess,
    onError,
    onNonOAuthError,
  }: {
    flow: 'implicit' | 'auth-code';
    onSuccess?: (value: TokenResponse | CodeResponse) => void;
    onError?: (
      value: TokenResponse | CodeResponse | NonOAuthError | Error,
    ) => void;
    onNonOAuthError?: (value: NonOAuthError) => void;
  } = $props();
  const auth = createGoogleLogin(
    untrack(() => ({
      flow,
      scope: 'calendar',
      onSuccess,
      onError,
      onNonOAuthError,
    })),
  );
</script>

<button onclick={() => auth.login({ prompt: 'consent' })}>login</button>
<output
  >{auth.loading ? 'loading' : 'idle'}:{auth.error?.message ?? 'ok'}</output
>
