<script lang="ts">
  import { GoogleOAuthState, setGoogleOAuthContext } from './context.svelte.js';
  import { loadGoogleScript } from './loader.js';

  interface Props {
    clientId: string;
    onScriptLoadSuccess?: () => void;
    onScriptLoadError?: (err: Error) => void;
    autoSelect?: boolean;
    cancelOnTapOutside?: boolean;
    nonce?: string;
    hd?: string;
    children?: import('svelte').Snippet;
  }

  let {
    clientId,
    onScriptLoadSuccess,
    onScriptLoadError,
    autoSelect = false,
    cancelOnTapOutside = true,
    nonce,
    hd,
    children,
  }: Props = $props();

  // Create and set the reactive context state using a getter closure
  const state = new GoogleOAuthState(() => clientId);
  setGoogleOAuthContext(state);

  // Load the Google script on the client side
  $effect(() => {
    let active = true;
    loadGoogleScript()
      .then(() => {
        if (!active) return;
        state.isLoaded = true;
        state.error = null;
        onScriptLoadSuccess?.();
      })
      .catch((err) => {
        if (!active) return;
        state.error = err;
        onScriptLoadError?.(err);
      });
    return () => {
      active = false;
    };
  });

  // The provider owns the single global Identity Services initialization.
  $effect(() => {
    if (!state.isLoaded) return;
    state.isInitialized = false;
    window.google.accounts.id.initialize({
      client_id: state.clientId,
      callback: (response) => state.dispatchCredential(response),
      auto_select: autoSelect,
      cancel_on_tap_outside: cancelOnTapOutside,
      nonce,
      hd,
    });
    state.isInitialized = true;
    return () => {
      state.isInitialized = false;
      window.google.accounts.id.cancel();
    };
  });
</script>

{#if children}
  {@render children()}
{/if}
