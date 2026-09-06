import { afterEach } from "vitest";
import { flushSync } from "svelte";

afterEach(() => {
  flushSync();
  for (const cookie of document.cookie.split(";")) {
    document.cookie = `${cookie.split("=")[0].trim()}=; Max-Age=0; Path=/`;
  }
  document.body.replaceChildren();
});
