<script lang="ts">
  import { untrack } from "svelte";
  import { auth, type User, type Claims } from './shared-auth.js';
  import SharedAuthChild from './SharedAuthChild.svelte';
  let { user = null, claims, interleave }: {
    user?: User | null;
    claims?: Claims;
    interleave?: () => void;
  } = $props();
  auth.init(() => user, () => claims);
  // A second render can happen while this tree's session is already initialized.
  untrack(() => interleave?.());
</script>
<SharedAuthChild />
