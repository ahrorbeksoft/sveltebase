import { authStorageKey } from "$lib/db/auth.svelte.js";
import type { User } from "$lib/db/types.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ cookies }) => {
  const rawUser = cookies.get(authStorageKey);

  let user: User | undefined;

  if (rawUser) {
    try {
      user = JSON.parse(rawUser) as User;
    } catch {
      cookies.delete(authStorageKey, { path: "/" });
    }
  }

  return {
    user
  };
};
