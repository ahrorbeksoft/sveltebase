<script lang="ts">
  import { untrack } from 'svelte';
  import { createGoogleLogin } from '../../src/google/google.svelte.js';
  import { getGoogleOAuthContext } from '../../src/google/context.svelte.js';
  import type { GoogleLoginOptions } from '../../src/google/types.js';
  let { options = {}, capture }: { options?: GoogleLoginOptions; capture: (value: ReturnType<typeof createGoogleLogin>, context: ReturnType<typeof getGoogleOAuthContext>) => void } = $props();
  const login = untrack(() => createGoogleLogin(options));
  const context = getGoogleOAuthContext();
  untrack(() => capture(login, context));
</script>
