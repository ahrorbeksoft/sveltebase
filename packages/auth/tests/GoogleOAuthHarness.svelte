<script lang="ts">
  import GoogleOAuthProvider from '../src/google/GoogleOAuthProvider.svelte';
  import GoogleOAuthAction from './GoogleOAuthAction.svelte';
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
</script>

<GoogleOAuthProvider clientId="client-id">
  <GoogleOAuthAction {flow} {onSuccess} {onError} {onNonOAuthError} />
</GoogleOAuthProvider>
