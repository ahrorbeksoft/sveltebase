/**
 * Claims decoded from a Google ID token.
 */
export interface GoogleData {
  iss: string;
  azp: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  nonce?: string;
  nbf?: number;
  name: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
  iat: number;
  exp: number;
  jti?: string;
}

/**
 * Response passed by Google Identity Services after an ID-token sign-in.
 */
export interface CredentialResponse {
  credential?: string;
  select_by?:
    | 'auto'
    | 'user'
    | 'user_1tap'
    | 'user_2tap'
    | 'btn_confirm'
    | 'btn_confirm_1tap'
    | 'btn_confirm_2tap';
}

/**
 * Configuration passed to `google.accounts.id.initialize`.
 */
export interface IdConfiguration {
  client_id: string;
  callback?: (response: CredentialResponse) => void;
  auto_select?: boolean;
  callback_parent_id?: string;
  cancel_on_tap_outside?: boolean;
  prompt_parent_id?: string;
  nonce?: string;
  context?: 'signin' | 'signup' | 'use';
  state_cookie_domain?: string;
  ux_mode?: 'popup' | 'redirect';
  allowed_parent_origin?: string | string[];
  intermediate_iframe_close_callback?: () => void;
  itp_support?: boolean;
  login_hint?: string;
  hd?: string;
}

/**
 * OAuth implicit-flow access token response.
 */
export interface TokenResponse {
  access_token: string;
  expires_in: string; // Secs
  hd?: string;
  prompt: string;
  token_type: string; // Bearer
  scope: string;
  state?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Configuration passed to Google's OAuth token client.
 */
export interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: NonOAuthError) => void;
  prompt?: 'none' | 'consent' | 'select_account';
  enable_serial_consent?: boolean;
  hint?: string;
  login_hint?: string;
  state?: string;
  include_granted_scopes?: boolean;
}

/**
 * OAuth authorization-code response.
 */
export interface CodeResponse {
  code: string;
  scope: string;
  state?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Configuration passed to Google's OAuth code client.
 */
export interface CodeClientConfig {
  client_id: string;
  scope: string;
  callback: (response: CodeResponse) => void;
  error_callback?: (error: NonOAuthError) => void;
  ux_mode?: 'popup' | 'redirect';
  redirect_uri?: string;
  prompt?: 'none' | 'consent' | 'select_account';
  enable_serial_consent?: boolean;
  hint?: string;
  login_hint?: string;
  state?: string;
  include_granted_scopes?: boolean;
}

/**
 * Non-OAuth popup or browser error from Google Identity Services.
 */
export interface NonOAuthError {
  type: 'popup_closed' | 'popup_blocked_by_browser' | 'unknown';
}

/**
 * Options accepted by `createGoogleLogin`.
 */
export interface GoogleLoginOptions {
  flow?: 'implicit' | 'auth-code';
  scope?: string;
  prompt?: 'none' | 'consent' | 'select_account';
  login_hint?: string;
  state?: string;
  overrideScope?: boolean;
  ux_mode?: 'popup' | 'redirect';
  redirect_uri?: string;
  onSuccess?: (response: any) => void;
  onError?: (error: any) => void;
  onNonOAuthError?: (error: NonOAuthError) => void;
}

/**
 * Options that can override an implicit token request at login time.
 */
export interface OverridableTokenClientConfig {
  prompt?: 'none' | 'consent' | 'select_account';
  login_hint?: string;
  state?: string;
}

/**
 * Notification object passed by Google One Tap prompt callbacks.
 */
export interface MomentNotification {
  isDisplayMoment: () => boolean;
  isDisplayed: () => boolean;
  isNotDisplayed: () => boolean;
  getNotDisplayedReason: () =>
    | 'browser_not_supported'
    | 'unknown_reason'
    | 'opt_out'
    | 'user_cancel'
    | 'suppressed_by_user'
    | 'unregistered_origin'
    | 'unknown_sharing_id'
    | 'third_party_cookies_disabled'
    | 'iss_missing'
    | 'client_id_missing'
    | 'credential_disabled'
    | 'secure_context_required'
    | 'hd_required';
  isSkippedMoment: () => boolean;
  getSkippedReason: () =>
    | 'auto_cancel'
    | 'user_cancel'
    | 'tap_outside'
    | 'iss_missing';
  isDismissedMoment: () => boolean;
  getDismissedReason: () =>
    | 'credential_returned'
    | 'cancel_called'
    | 'flow_restarted'
    | 'user_cancel'
    | 'tap_outside';
  getMomentType: () => 'display' | 'skipped' | 'dismissed';
}
