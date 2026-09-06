<script lang="ts">
  import GoogleOAuthProvider from '../../src/google/GoogleOAuthProvider.svelte';
  import GoogleHarness from './GoogleHarness.svelte';
  let { capture, success, failure }: { capture: (...args: any[]) => void; success?: () => void; failure?: (error: Error) => void } = $props();
</script>
<GoogleOAuthProvider clientId="provider-client" onScriptLoadSuccess={success} onScriptLoadError={failure}>
  <GoogleHarness {capture} />
</GoogleOAuthProvider>
