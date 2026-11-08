import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

/**
 * The sign-in callback is the one place where a stranger gets to hand this app a credential, so
 * what is worth testing is the refusals: an unsolicited `?code=` must never be exchanged.
 *
 * `auth.ts` reads its configuration at import time, so the environment has to be in place before
 * the dynamic import below — hence no static import of the module.
 */
const ORIGIN = 'https://app.example.com';
process.env.VITE_COGNITO_URL = 'https://example.auth.us-east-1.amazoncognito.com';
process.env.VITE_COGNITO_CLIENT_ID = 'test-client-id';

/** Minimal `sessionStorage`: a Map with the three methods the module calls. */
const store = new Map<string, string>();
const sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

let href = `${ORIGIN}/`;
/** Where `signIn` sent the browser, so a test can read back the `state` it actually minted. */
let assigned: string | null = null;

const window = {
  get location() {
    return {
      get href() {
        return href;
      },
      origin: ORIGIN,
      assign: (to: string) => void (assigned = to),
    };
  },
  history: { replaceState: (_s: unknown, _t: string, url: string) => void (href = url) },
};

/** Requests the module made, and the canned response it gets back. */
let fetched: { url: string; body: URLSearchParams }[] = [];
let tokenResponse: { status: number; payload: unknown } = {
  status: 200,
  payload: { id_token: 'id-token', expires_in: 3600, refresh_token: 'refresh-token' },
};

Object.assign(globalThis, {
  sessionStorage,
  window,
  fetch: (url: string, init: { body: URLSearchParams }) => {
    fetched.push({ url, body: init.body });
    return Promise.resolve({
      ok: tokenResponse.status < 400,
      status: tokenResponse.status,
      json: () => Promise.resolve(tokenResponse.payload),
      text: () => Promise.resolve(''),
    });
  },
});

const { authEnabled, completeSignIn, signIn, signedIn } = await import('../src/lib/auth.js');

beforeEach(() => {
  store.clear();
  fetched = [];
  assigned = null;
  href = `${ORIGIN}/`;
  tokenResponse = {
    status: 200,
    payload: { id_token: 'id-token', expires_in: 3600, refresh_token: 'refresh-token' },
  };
});

/** Runs a real `signIn` and returns the `state`/`nonce` it put on the authorize request. */
async function startSignIn(): Promise<{ state: string; nonce: string }> {
  await signIn();
  assert.ok(assigned, 'signIn should have redirected to the hosted UI');
  const params = new URL(assigned).searchParams;
  const state = params.get('state');
  const nonce = params.get('nonce');
  assert.ok(state && nonce, 'authorize request must carry both state and nonce');
  return { state, nonce };
}

/** Puts the browser on a callback URL, the way the hosted UI would. */
function arriveAt(query: Record<string, string>): void {
  href = `${ORIGIN}/?${new URLSearchParams(query).toString()}`;
}

test('the module is configured, or every test below passes vacuously', () => {
  assert.equal(authEnabled, true);
});

test('the authorize request carries an unguessable state and nonce', async () => {
  const first = await startSignIn();
  const second = await startSignIn();
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.nonce, first.state);
  // Long enough that guessing it is not a strategy.
  assert.ok(first.state.length >= 32, `state too short: ${first.state}`);
});

test('the happy path exchanges the code and strips the callback parameters', async () => {
  const { state } = await startSignIn();
  arriveAt({ code: 'auth-code', state });

  assert.equal(await completeSignIn(), true);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].body.get('code'), 'auth-code');
  assert.equal(fetched[0].body.get('grant_type'), 'authorization_code');
  assert.equal(signedIn(), true);
  assert.equal(href, `${ORIGIN}/`);
});

test('a state that does not match the pending attempt is refused without an exchange', async () => {
  await startSignIn();
  arriveAt({ code: 'attacker-code', state: 'not-the-state-we-minted' });

  await assert.rejects(completeSignIn, /does not match a sign-in started in this tab/);
  assert.equal(fetched.length, 0, 'the code must not be exchanged');
  assert.equal(signedIn(), false);
});

test('a code with no state at all is refused — that is the login-CSRF link', async () => {
  await startSignIn();
  arriveAt({ code: 'attacker-code' });

  await assert.rejects(completeSignIn, /does not match a sign-in started in this tab/);
  assert.equal(fetched.length, 0);
  assert.equal(signedIn(), false);
});

test('a callback arriving with no sign-in pending is refused, not silently ignored', async () => {
  arriveAt({ code: 'attacker-code', state: 'anything' });

  await assert.rejects(completeSignIn, /does not match a sign-in started in this tab/);
  assert.equal(fetched.length, 0);
});

test('the pending state is single-use, so a replayed callback URL fails', async () => {
  const { state } = await startSignIn();
  const callback = { code: 'auth-code', state };

  arriveAt(callback);
  assert.equal(await completeSignIn(), true);

  // Same URL again — as a back button or a shared link would produce.
  arriveAt(callback);
  await assert.rejects(completeSignIn, /does not match a sign-in started in this tab/);
  assert.equal(fetched.length, 1, 'only the first callback may reach the token endpoint');
});

test('a denied consent comes back as ?error= and is surfaced, not swallowed', async () => {
  await startSignIn();
  arriveAt({ error: 'access_denied', error_description: 'User denied consent', state: 'x' });

  await assert.rejects(completeSignIn, /access_denied.*User denied consent/);
  assert.equal(fetched.length, 0);
  assert.equal(signedIn(), false);
  // Scrubbed, so a reload does not re-raise a stale error.
  assert.equal(href, `${ORIGIN}/`);
});

test('no callback parameters at all means "never tried to sign in", not an error', async () => {
  assert.equal(await completeSignIn(), false);
  assert.equal(fetched.length, 0);
});

test('a deep link survives the callback scrub', async () => {
  const { state } = await startSignIn();
  href = `${ORIGIN}/?revision=r-42&${new URLSearchParams({ code: 'auth-code', state }).toString()}`;

  assert.equal(await completeSignIn(), true);
  assert.equal(href, `${ORIGIN}/?revision=r-42`);
});
