<script lang="ts">
    import { i18n } from "$lib/i18n";
  import "../app.css";
  import type { Snippet } from "svelte";

  const {data, children} = $props<{
    data: {
      cookies?: { name: string; value: string }[];
    };
    children: Snippet;
  }>();


    i18n.init(() =>data.cookies);


</script>

{@render children()}
