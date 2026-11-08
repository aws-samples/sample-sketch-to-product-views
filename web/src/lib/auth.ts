/**
 * Cognito sign-in via the hosted UI: authorization-code flow with PKCE, no client secret.
 *
 * Optional by construction: with no `VITE_COGNITO_*` build vars, auth is disabled and the SPA
 * sends unauthenticated requests.
 */

/** `import.meta.env` exists only in a Vite build; the Node test runner reads `process.env`. */
const ENV = (import.meta.env ??
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
  {}) as Record<string, string | undefined>;

const HOSTED_UI = ENV.VITE_COGNITO_URL ?? '';
const CLIENT_ID = ENV.VITE_COGNITO_CLIENT_ID ?? '';

/** A subset of the app client's scopes. `openid` is what makes Cognito issue an id token. */
const SCOPES = 'openid email profile';

const VERIFIER_KEY = 'product-views.pkce.verifier';
const PENDING_KEY = 'product-views.oauth.pending';
const SESSION_KEY = 'product-views.session';

/** Refresh this long before expiry, so no request leaves with a token that dies in flight. */
const SKEW_MS = 60_000;

/** The expiry and refresh token tell "signed out" apart from "token expired". */
type Session = { id: string; expiresAt: number; refresh?: string };

type TokenResponse = { id_token: string; expires_in: number; refresh_token?: string };

/** The attempt this tab is waiting on. `state` blocks login CSRF. */
type Pending = { state: string; nonce: string };

function isPending(value: unknown): value is Pending {
  if (typeof value !== 'object' || value === null) return false;
  const { state, nonce } = value as Partial<Pending>;
  return typeof state === 'string' && state !== '' && typeof nonce === 'string';
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const { id, expiresAt, refresh } = value as Partial<Session>;
  return (
    typeof id === 'string' &&
    id !== '' &&
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    (refresh === undefined || typeof refresh === 'string')
  );
}

/** An unrecognised or truncated session is treated as signed out. */
function readSession(): Session | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSession(parsed)) return parsed;
  } catch {
    // Unparseable: same verdict as unrecognised.
  }
  sessionStorage.removeItem(SESSION_KEY);
  return null;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const { id_token: id, expires_in: expiresIn } = value as Partial<TokenResponse>;
  return typeof id === 'string' && id !== '' && typeof expiresIn === 'number';
}

/**
 * Accepted risk: `sessionStorage` is readable by any script on this origin, refresh token
 * included. A backend-for-frontend with an HttpOnly cookie is the fix.
 */
function store(tokens: TokenResponse): void {
  const existing = readSession();
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      id: tokens.id_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      // A refresh grant does not repeat the refresh token.
      refresh: tokens.refresh_token ?? existing?.refresh,
    } satisfies Session),
  );
}

export const authEnabled = HOSTED_UI !== '' && CLIENT_ID !== '';

/** Must match a `callback_urls` entry exactly: the bare origin, no path, no trailing slash. */
const redirectUri = (): string => window.location.origin;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A live token, or an expired one we can renew. Synchronous: the header reads it on paint. */
export function signedIn(): boolean {
  if (!authEnabled) return false;
  const session = readSession();
  if (!session) return false;
  return session.refresh !== undefined || session.expiresAt - SKEW_MS > Date.now();
}

/** Drops the local session without redirecting. */
export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

/** One refresh for a burst of parallel requests. */
let refreshing: Promise<string | null> | null = null;

/** A usable id token, renewed if near expiry. `null` means signed out. */
export async function idToken(): Promise<string | null> {
  if (!authEnabled) return null;
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt - SKEW_MS > Date.now()) return session.id;
  if (!session.refresh) {
    clearSession();
    return null;
  }
  refreshing ??= refresh(session.refresh).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Runs outlive the one-hour id token, so polling renews it. */
async function refresh(token: string): Promise<string | null> {
  const res = await fetch(`${HOSTED_UI}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: token,
    }),
  });
  if (!res.ok) {
    clearSession();
    return null;
  }
  const tokens: unknown = await res.json().catch(() => null);
  if (!isTokenResponse(tokens)) {
    clearSession();
    return null;
  }
  store(tokens);
  return tokens.id_token;
}

/**
 * Redirects to the hosted UI. Verifier, state and nonce live in per-tab `sessionStorage`, so
 * only the tab that started the attempt can complete it.
 */
export async function signIn(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const pending: Pending = { state: crypto.randomUUID(), nonce: crypto.randomUUID() };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    state: pending.state,
    // Not checked here: the SPA never trusts the id token, the API's JWT authorizer does.
    nonce: pending.nonce,
  });

  window.location.assign(`${HOSTED_UI}/oauth2/authorize?${params.toString()}`);
}

export function signOut(): void {
  clearSession();
  window.location.assign(
    `${HOSTED_UI}/logout?${new URLSearchParams({
      client_id: CLIENT_ID,
      logout_uri: redirectUri(),
    }).toString()}`,
  );
}

/** Read and delete: every callback artefact is single-use. */
function consume(key: string): string | null {
  const value = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  return value;
}

/** Drops only the hosted UI's parameters, so a reload is not a second attempt. */
function scrubCallback(url: URL): void {
  for (const param of ['code', 'state', 'error', 'error_description'])
    url.searchParams.delete(param);
  window.history.replaceState({}, '', url.toString());
}

/**
 * Completes the flow if the URL carries `?code=`. `true`: signed in; `false`: no callback.
 * A failed attempt throws.
 */
export async function completeSignIn(): Promise<boolean> {
  if (!authEnabled) return false;

  const url = new URL(window.location.href);

  const failure = url.searchParams.get('error');
  if (failure !== null) {
    const detail = url.searchParams.get('error_description');
    consume(VERIFIER_KEY);
    consume(PENDING_KEY);
    scrubCallback(url);
    throw new Error(`Sign-in was refused by Cognito (${failure})${detail ? `: ${detail}` : '.'}`);
  }

  const code = url.searchParams.get('code');
  if (!code) return false;

  // Consumed before validation, so a replayed callback cannot pass twice.
  const raw = consume(PENDING_KEY);
  const verifier = consume(VERIFIER_KEY);

  let pending: unknown = null;
  try {
    pending = raw === null ? null : JSON.parse(raw);
  } catch {
    // Unparseable: same verdict as absent.
  }
  const returnedState = url.searchParams.get('state');
  // Refuse before the exchange: exchanging a foreign code is the login CSRF itself.
  if (!isPending(pending) || returnedState === null || returnedState !== pending.state) {
    scrubCallback(url);
    throw new Error(
      'Sign-in was rejected: this callback does not match a sign-in started in this tab. ' +
        'Start again from the sign-in button.',
    );
  }

  if (!verifier) throw new Error('Sign-in could not be completed: no PKCE verifier in this tab.');

  const res = await fetch(`${HOSTED_UI}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }

  const tokens: unknown = await res.json();
  if (!isTokenResponse(tokens)) {
    throw new Error('Sign-in could not be completed: the token response was not usable.');
  }
  store(tokens);
  scrubCallback(url);
  return true;
}
