import { getContext, setContext } from 'svelte';

export const GOOGLE_OAUTH_CONTEXT_KEY = Symbol('google-oauth-context');

export class GoogleOAuthState {
  #clientIdGetter: () => string;
  isLoaded = $state<boolean>(false);
  error = $state<Error | null>(null);

  get clientId(): string {
    return this.#clientIdGetter();
  }

  constructor(clientIdGetter: () => string) {
    this.#clientIdGetter = clientIdGetter;
  }
}

export function setGoogleOAuthContext(state: GoogleOAuthState): void {
  setContext(GOOGLE_OAUTH_CONTEXT_KEY, state);
}

export function getGoogleOAuthContext(): GoogleOAuthState {
  const context = getContext<GoogleOAuthState>(GOOGLE_OAUTH_CONTEXT_KEY);
  if (!context) {
    throw new Error('Google OAuth Context not found. Make sure your component is wrapped in <GoogleOAuthProvider>.');
  }
  return context;
}
