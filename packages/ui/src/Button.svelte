<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ButtonVariant } from "./types.js";

  type Props = {
    children?: Snippet;
    href?: string;
    type?: "button" | "submit" | "reset";
    variant?: ButtonVariant;
  };

  let { children, href, type = "button", variant = "solid" }: Props = $props();
</script>

{#if href}
  <a class={`button ${variant}`} href={href}>
    {@render children?.()}
  </a>
{:else}
  <button class={`button ${variant}`} type={type}>
    {@render children?.()}
  </button>
{/if}

<style>
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border-radius: 999px;
    border: 1px solid transparent;
    padding: 0.8rem 1.2rem;
    font: 600 0.95rem/1 system-ui, sans-serif;
    text-decoration: none;
    transition:
      transform 120ms ease,
      border-color 120ms ease,
      background-color 120ms ease,
      color 120ms ease;
  }

  .button:hover {
    transform: translateY(-1px);
  }

  .solid {
    background: #111827;
    color: white;
  }

  .ghost {
    border-color: #d1d5db;
    background: white;
    color: #111827;
  }
</style>
