import { getContext, setContext } from 'svelte';

/**
 * Svelte context key used by Google OAuth provider and child components.
 */
export const GOOGLE_OAUTH_CONTEXT_KEY = Symbol('google-oauth-context');

/**
 * Reactive Google OAuth provider state.
 *
 * Child components use this to read the current client id and whether the
 * Google Identity Services script has loaded.
 */
export class GoogleOAuthState {
  #clientIdGetter: () => string;
  isLoaded = $state<boolean>(false);
  error = $state<Error | null>(null);

  /** Current Google OAuth client id. */
  get clientId(): string {
    return this.#clientIdGetter();
  }

  /**
   * Creates provider state from a getter so prop changes stay reactive.
   */
  constructor(clientIdGetter: () => string) {
    this.#clientIdGetter = clientIdGetter;
  }
}

/**
 * Stores Google OAuth state in Svelte context.
 *
 * Called by `GoogleOAuthProvider`.
 */
export function setGoogleOAuthContext(state: GoogleOAuthState): void {
  setContext(GOOGLE_OAUTH_CONTEXT_KEY, state);
}

/**
 * Reads Google OAuth state from Svelte context.
 *
 * Throws when called outside `GoogleOAuthProvider`.
 */
export function getGoogleOAuthContext(): GoogleOAuthState {
  const context = getContext<GoogleOAuthState>(GOOGLE_OAUTH_CONTEXT_KEY);
  if (!context) {
    throw new Error('Google OAuth Context not found. Make sure your component is wrapped in <GoogleOAuthProvider>.');
  }
  return context;
}
