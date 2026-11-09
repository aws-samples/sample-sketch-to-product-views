import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { PipelineState } from '@sketch-to-product-views/contracts';
import {
  LONGEST_URL_SECONDS,
  MAX_REUSE_MS,
  SESSION_SECONDS,
  URL_REFRESH_MS,
  clearUserScopes,
  etagFor,
  getRevision,
  presignDownload,
  runWithStoreClients,
  sessionName,
  userScope,
  type StoreClients,
} from '../src/store/index.js';

/**
 * The API's token exchange, with STS and the AWS clients faked: no call leaves the process.
 */

const ROLE = 'arn:aws:iam::000000000000:role/test-api-user-data';
const HOUR = 3600_000;

interface StsCall {
  RoleArn?: string;
  RoleSessionName?: string;
  DurationSeconds?: number;
  Tags?: { Key?: string; Value?: string }[];
}

function fakeSts(lifetimeMs = HOUR, now: () => number = Date.now) {
  const calls: StsCall[] = [];
  return {
    calls,
    sts: {
      send: async (command: { input: StsCall }) => {
        calls.push(command.input);
        return {
          Credentials: {
            AccessKeyId: `AKIA${calls.length}`,
            SecretAccessKey: 'secret', // pragma: allowlist secret
            SessionToken: 'token',
            Expiration: new Date(now() + lifetimeMs),
          },
        };
      },
    } as never,
  };
}

afterEach(() => {
  clearUserScopes();
  delete process.env.STORE_REQUIRES_USER_SCOPE;
});

test('the role is assumed with the caller as the only session tag, for one hour', async () => {
  const { sts, calls } = fakeSts();
  await userScope('user-1', { roleArn: ROLE, sts });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].RoleArn, ROLE);
  assert.deepEqual(calls[0].Tags, [{ Key: 'sub', Value: 'user-1' }]);
  assert.equal(calls[0].DurationSeconds, SESSION_SECONDS);
  // Names the user in CloudTrail without the raw sub, in the characters STS allows.
  assert.equal(calls[0].RoleSessionName, sessionName('user-1'));
  assert.match(calls[0].RoleSessionName!, /^[\w+=,.@-]{2,64}$/);
  assert.doesNotMatch(calls[0].RoleSessionName!, /user-1/);
});

test('an id that could escape its prefix never reaches STS', async () => {
  const { sts, calls } = fakeSts();
  for (const bad of ['', 'a/b', 'a#b', 'a*', 'a b']) {
    await assert.rejects(() => userScope(bad, { roleArn: ROLE, sts }), /invalid owner id/, bad);
  }
  assert.equal(calls.length, 0);
});

test('no credentials from STS is an error, not a fallback', async () => {
  const sts = { send: async () => ({}) } as never;
  await assert.rejects(() => userScope('user-1', { roleArn: ROLE, sts }), /no credentials/);
});

test('credentials are reused per user, never across users', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const { sts, calls } = fakeSts(HOUR, now);

  const a1 = await userScope('user-1', { roleArn: ROLE, sts, now });
  clock += 60_000;
  const a2 = await userScope('user-1', { roleArn: ROLE, sts, now });
  const b = await userScope('user-2', { roleArn: ROLE, sts, now });

  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.deepEqual(
    calls.map((c) => c.Tags?.[0]?.Value),
    ['user-1', 'user-2'],
  );
});

test('credentials are refreshed after the reuse window', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const { sts, calls } = fakeSts(HOUR, now);

  await userScope('user-1', { roleArn: ROLE, sts, now });
  clock += MAX_REUSE_MS;
  await userScope('user-1', { roleArn: ROLE, sts, now });
  assert.equal(calls.length, 2);
});

test('credentials that would not outlive a download URL are not reused', async () => {
  // A session shorter than the longest URL plus the margin: every call must fetch anew, or a
  // URL signed with it would die before its own expiry.
  let clock = 1_000_000;
  const now = () => clock;
  const { sts, calls } = fakeSts(LONGEST_URL_SECONDS * 1000, now);

  await userScope('user-1', { roleArn: ROLE, sts, now });
  clock += 1000;
  await userScope('user-1', { roleArn: ROLE, sts, now });
  assert.equal(calls.length, 2);
});

test('the store uses the scoped clients, and builds the key from the owner', async () => {
  process.env.TABLE_NAME = 'test-table';
  const sent: { input: Record<string, unknown> }[] = [];
  const clients = {
    dynamodb: {
      send: async (command: { input: Record<string, unknown> }) => {
        sent.push(command);
        return { Items: [] };
      },
    },
    s3: {},
    presigner: {},
  } as unknown as StoreClients;

  const found = await runWithStoreClients(clients, () =>
    getRevision({ owner: 'user-1', revisionId: 'r-1' }),
  );

  assert.equal(found, undefined);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    (sent[0].input.ExpressionAttributeValues as Record<string, unknown>)[':pk'],
    'USER#user-1#REV#r-1',
  );
});

test('with a user scope required, the store refuses to run outside one', async () => {
  process.env.STORE_REQUIRES_USER_SCOPE = 'true';
  process.env.TABLE_NAME = 'test-table';
  await assert.rejects(
    () => getRevision({ owner: 'user-1', revisionId: 'r-1' }),
    /outside a user scope/,
  );
  process.env.ARTIFACTS_BUCKET = 'test-bucket';
  await assert.rejects(() => presignDownload('user/user-1/x.png'), /outside a user scope/);
});

test('a download URL never outlives the session that signs it', async () => {
  process.env.ARTIFACTS_BUCKET = 'test-bucket';
  const url = await presignDownload('user/user-1/x.png', 7 * 24 * 3600);
  assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), String(LONGEST_URL_SECONDS));
});

test('an unchanged run still gets a new ETag every refresh window, so its URLs are re-minted', () => {
  const state = { updatedAt: 't', events: [], status: 'running' } as unknown as PipelineState;
  const start = 100 * URL_REFRESH_MS;
  assert.equal(etagFor(state, start), etagFor(state, start + URL_REFRESH_MS - 1));
  assert.notEqual(etagFor(state, start), etagFor(state, start + URL_REFRESH_MS));
  // Refreshed well before the URLs the SPA holds expire.
  assert.ok(URL_REFRESH_MS < LONGEST_URL_SECONDS * 1000);
});
