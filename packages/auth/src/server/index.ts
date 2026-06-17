import { defineSync, type SyncContext } from "@sveltebase/sync";
import { getUserFromRequest, verifyJWT, getVerifiedUserFromRequest } from "../index.js";

export interface SyncAuthConfig<User = any> {
  /**
   * Secret key used to verify the JWT tokens.
   */
  jwtSecret: string;
  /**
   * Name of the session cookie.
   * @default "sf_session"
   */
  cookieName?: string;
  /**
   * Optional database hook to verify if the user still exists or is active.
   */
  verifyUser?: (user: User, ctx: SyncContext) => Promise<boolean>;
  /**
   * Optional database hook to persist user mutations.
   */
  onUpdate?: (
    userId: User extends { id: infer Id } ? Id : string,
    changes: Partial<User>,
    ctx: SyncContext
  ) => Promise<User>;
}

/**
 * Creates a Svelteflare Sync handler for WebSocket-based session validation.
 * Registers the read-only "users" channel.
 */
export function createAuthSync<User = any>(config: SyncAuthConfig<User>) {
  const cookieName = config.cookieName || "sf_session";

  return defineSync<User>({
    channel: "users",

    // Runs automatically when the client queries/subscribes to the "users" channel
    authorize: async (ctx) => {
      const user = getUserFromRequest<{ id: string; token: string }>(ctx.request, cookieName);
      if (!user) {
        throw new Error("Unauthorized: No session cookie found");
      }

      // 1. Cryptographically verify the token
      let payload;
      try {
        payload = await verifyJWT(user.token, config.jwtSecret);
      } catch {
        throw new Error("Unauthorized: Invalid token");
      }

      // 2. Perform optional database validation (check if active/deleted)
      if (config.verifyUser) {
        const isValid = await config.verifyUser(payload as User, ctx);
        if (!isValid) {
          throw new Error("Unauthorized: User no longer exists");
        }
      }
    },

    // Returns the current session user so the client knows it is successfully authorized
    fetch: async (ctx) => {
      const user = getUserFromRequest<User>(ctx.request, cookieName);
      return user ? [user] : [];
    },

    create: async () => {
      throw new Error("Forbidden: User creation is disabled on sync channel");
    },
    
    update: async (ctx, key, changes) => {
      // Verify token authenticity before allowing writes
      const user = await getVerifiedUserFromRequest<{ id: any; token: string }>(ctx.request, config.jwtSecret, cookieName);
      if (!user) {
        throw new Error("Unauthorized: Invalid session");
      }

      // Prevent users from updating other users' records (comparing string representations to support both string and number IDs)
      if (String(user.id) !== String(key)) {
        throw new Error("Forbidden: Cannot modify other user profiles");
      }

      // Persist update via dev's DB hook if registered
      if (config.onUpdate) {
        const typedKey = (typeof user.id === "number" ? Number(key) : key) as any;
        const dbResult = await config.onUpdate(typedKey, changes, ctx);
        return {
          ...dbResult,
          token: user.token
        } as unknown as User;
      }

      // Fallback: return merged changes
      return { ...user, ...changes } as unknown as User;
    },

    delete: async () => {
      throw new Error("Forbidden: User deletion is disabled on sync channel");
    },

    scope: (ctx, action, data) => {
      return [String((data as any).id)];
    }
  });
}
