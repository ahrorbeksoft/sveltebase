<script lang="ts">
  import GoogleLogin from '../src/google/GoogleLogin.svelte';
  import GoogleOneTapLogin from '../src/google/GoogleOneTapLogin.svelte';
  import GoogleOAuthProvider from '../src/google/GoogleOAuthProvider.svelte';
  import type { CredentialResponse } from '../src/google/types.js';

  let {
    mode,
    onSuccess,
  }: {
    mode: 'button' | 'one-tap' | 'both';
    onSuccess: (response: CredentialResponse) => void;
  } = $props();
</script>

<GoogleOAuthProvider clientId="client-id">
  {#if mode === 'button' || mode === 'both'}
    <GoogleLogin {onSuccess} />
  {/if}
  {#if mode === 'one-tap' || mode === 'both'}
    <GoogleOneTapLogin {onSuccess} />
  {/if}
</GoogleOAuthProvider>
