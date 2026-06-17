import { getGoogleOAuthContext } from './context.svelte.js';
import type { GoogleLoginOptions, GoogleData } from './types.js';

/**
 * Triggers the Google Identity Services OAuth2 flow (Token or Code client).
 * Returns an object containing the trigger function `login`, and the reactive state properties `loading` and `error`.
 */
export function createGoogleLogin(options: GoogleLoginOptions = {}) {
  const ctx = getGoogleOAuthContext();
  
  let loading = $state(false);
  let error = $state<Error | null>(null);
  
  const login = (overrideOptions?: any) => {
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
    
    const clientMethod = flow === 'implicit' ? 'initTokenClient' : 'initCodeClient';
    const finalScope = overrideScope ? scope : `openid profile email ${scope}`.trim().replace(/\s+/g, ' ');
    
    try {
      const client = window.google.accounts.oauth2[clientMethod]({
        client_id: ctx.clientId,
        scope: finalScope,
        prompt,
        login_hint,
        state,
        ux_mode,
        redirect_uri,
        callback: (response: any) => {
          loading = false;
          if (response.error) {
            error = new Error(response.error_description || response.error);
            options.onError?.(response);
          } else {
            options.onSuccess?.(response);
          }
        },
        error_callback: (nonOAuthError: any) => {
          loading = false;
          error = new Error(nonOAuthError.type || 'Non-OAuth Error');
          options.onNonOAuthError?.(nonOAuthError);
          options.onError?.(nonOAuthError);
        }
      });
      
      if (flow === 'implicit') {
        (client as any).requestAccessToken(overrideOptions);
      } else {
        (client as any).requestCode();
      }
    } catch (err: any) {
      loading = false;
      error = err;
      options.onError?.(err);
    }
  };
  
  return {
    login,
    get loading() { return loading; },
    get error() { return error; }
  };
}

/**
 * Logs out the user from Google Identity Services session (disables auto-select).
 */
export function googleLogout(): void {
  if (typeof window !== 'undefined' && window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }
}

/**
 * Decodes the credential JWT returned by Google Identity Services.
 * Returns a typed `GoogleData` object.
 */
export function decodeCredentials<T = GoogleData>(credential: string): T {
  const parts = credential.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token status: JWT must have 3 parts');
  }
  const payload = parts[1];
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const paddedBase64 = pad ? base64 + '='.repeat(4 - pad) : base64;
  
  let decodedStr: string;
  if (typeof atob === 'function') {
    decodedStr = atob(paddedBase64);
  } else if (typeof Buffer !== 'undefined') {
    decodedStr = Buffer.from(paddedBase64, 'base64').toString('binary');
  } else {
    throw new Error('Environment not supported: missing base64 decoding helper');
  }
  
  const bytes = new Uint8Array(decodedStr.length);
  for (let i = 0; i < decodedStr.length; i++) {
    bytes[i] = decodedStr.charCodeAt(i);
  }
  const textDecoder = new TextDecoder('utf-8');
  return JSON.parse(textDecoder.decode(bytes)) as T;
}
