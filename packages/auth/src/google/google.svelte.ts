import { getGoogleOAuthContext } from './context.svelte.js';
import type {
  CodeResponse,
  GoogleLoginOptions,
  NonOAuthError,
  OverridableTokenClientConfig,
  TokenResponse,
} from './types.js';

/**
 * Triggers the Google Identity Services OAuth2 flow (Token or Code client).
 * Returns an object containing the trigger function `login`, and the reactive state properties `loading` and `error`.
 *
 * Call `login()` from a click handler. The provider must already have loaded
 * the Google script.
 *
 * @example
 * ```ts
 * const google = createGoogleLogin({
 *   scope: "profile email",
 *   onSuccess: (response) => auth.loginWithGoogle(response.credential)
 * });
 * ```
 */
export function createGoogleLogin(options: GoogleLoginOptions = {}) {
  const ctx = getGoogleOAuthContext();

  let loading = $state(false);
  let error = $state<Error | null>(null);

  const login = (overrideOptions?: OverridableTokenClientConfig) => {
    if (!ctx.isLoaded) {
      console.warn('Google Identity Services script is not loaded yet');
      return;
    }

    loading = true;
    error = null;

    const flow = options.flow ?? 'implicit';
    const scope = options.scope ?? '';
    const overrideScope = options.overrideScope ?? false;
    const prompt = options.prompt;
    const login_hint = options.login_hint;
    const state = options.state;
    const ux_mode = options.ux_mode ?? 'popup';
    const redirect_uri = options.redirect_uri;

    const finalScope = overrideScope
      ? scope
      : `openid profile email ${scope}`.trim().replace(/\s+/g, ' ');
    const handleResponse = (response: TokenResponse | CodeResponse) => {
      loading = false;
      if (response.error) {
        error = new Error(response.error_description || response.error);
        options.onError?.(response);
      } else {
        options.onSuccess?.(response);
      }
    };
    const handlePopupError = (nonOAuthError: { type: string }) => {
      loading = false;
      error = new Error(nonOAuthError.type || 'Non-OAuth Error');
      const normalized = nonOAuthError as NonOAuthError;
      options.onNonOAuthError?.(normalized);
      options.onError?.(normalized);
    };

    try {
      if (flow === 'implicit') {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: ctx.clientId,
          scope: finalScope,
          prompt,
          login_hint,
          state,
          callback: handleResponse,
          error_callback: handlePopupError,
        });
        client.requestAccessToken(overrideOptions);
      } else {
        const client = window.google.accounts.oauth2.initCodeClient({
          client_id: ctx.clientId,
          scope: finalScope,
          login_hint,
          state,
          ux_mode,
          redirect_uri,
          callback: handleResponse,
          error_callback: handlePopupError,
        });
        client.requestCode();
      }
    } catch (cause: unknown) {
      loading = false;
      error = cause instanceof Error ? cause : new Error('Google login failed');
      options.onError?.(error);
    }
  };

  return {
    login,
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
  };
}

/**
 * Logs out the user from Google Identity Services session (disables auto-select).
 *
 * This does not delete your app session cookie; call your app logout flow for
 * that.
 */
export function googleLogout(): void {
  if (typeof window !== 'undefined' && window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }
}
