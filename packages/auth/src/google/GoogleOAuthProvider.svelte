<script lang="ts">
  import { GoogleOAuthState, setGoogleOAuthContext } from './context.svelte.js';
  import { loadGoogleScript } from './loader';

  interface Props {
    clientId: string;
    onScriptLoadSuccess?: () => void;
    onScriptLoadError?: (err: Error) => void;
    children?: import('svelte').Snippet;
  }

  let {
    clientId,
    onScriptLoadSuccess,
    onScriptLoadError,
    children
  }: Props = $props();

  // Create and set the reactive context state using a getter closure
  const state = new GoogleOAuthState(() => clientId);
  setGoogleOAuthContext(state);

  // Load the Google script on the client side
  $effect(() => {
    loadGoogleScript()
      .then(() => {
        state.isLoaded = true;
        onScriptLoadSuccess?.();
      })
      .catch((err) => {
        state.error = err;
        onScriptLoadError?.(err);
      });
  });
</script>

{#if children}
  {@render children()}
{/if}
