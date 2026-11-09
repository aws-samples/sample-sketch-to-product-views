import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assertOwnerId } from './owner.js';

/**
 * Per-user store clients: the API's token exchange.
 *
 * The API Lambda's own role has no DynamoDB or S3 access. For each request it assumes the
 * user-data role with the caller's verified `sub` as a session tag, and the store uses those
 * credentials. The role's policy only allows keys that start with that tag
 * (`USER#${aws:PrincipalTag/sub}#*` in DynamoDB, `user/${aws:PrincipalTag/sub}/*` in S3,
 * infra/modules/api), so a request can only reach its caller's data even if the code builds a
 * wrong key: IAM denies it.
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html
 *
 * The pipeline does not use this: it outlives the user's session and keeps its service role.
 */

export interface StoreClients {
  dynamodb: DynamoDBDocumentClient;
  s3: S3Client;
  /** See `presignClient` in ./artifacts.ts for why presigning needs its own client. */
  presigner: S3Client;
}

/** The marshalling every document client in this package uses. */
export function documentClient(base: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
}

const scope = new AsyncLocalStorage<StoreClients>();

/** Runs `fn` with the store reading and writing through `clients`. */
export function runWithStoreClients<T>(clients: StoreClients, fn: () => Promise<T>): Promise<T> {
  return scope.run(clients, fn);
}

/**
 * The clients of the current user scope, or `undefined` outside one. With
 * `STORE_REQUIRES_USER_SCOPE=true` (the API), a store call outside a scope throws instead of
 * falling back to the function's own credentials: fail closed, before IAM would deny it anyway.
 */
export function scopedClients(): StoreClients | undefined {
  const clients = scope.getStore();
  if (!clients && process.env.STORE_REQUIRES_USER_SCOPE === 'true') {
    throw new Error('store used outside a user scope');
  }
  return clients;
}

/**
 * A presigned URL dies when the credentials that signed it expire, whatever its own expiry
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), and a role
 * assumed by a role lasts at most one hour
 * (https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html).
 * So credentials are reused only while they still outlive the longest URL signed with them,
 * plus a margin, and never for more than `MAX_REUSE_MS`.
 */
export const SESSION_SECONDS = 3600;
/** Longest presigned URL the API signs (GET, see ./artifacts.ts). */
export const LONGEST_URL_SECONDS = 2700;
const MARGIN_MS = 5 * 60_000;
export const MAX_REUSE_MS = 10 * 60_000;
/** Enough for every user active in one warm Lambda instance; the oldest is dropped first. */
const MAX_CACHED = 100;

interface Cached {
  clients: StoreClients;
  fetchedAt: number;
  expiresAt: number;
}

const cache = new Map<string, Cached>();

export interface UserScopeOptions {
  roleArn: string;
  sts?: Pick<STSClient, 'send'>;
  now?: () => number;
}

let defaultSts: STSClient | undefined;

/**
 * The store clients for one user, from `AssumeRole` on the user-data role with `sub` as the
 * only session tag. Throws on an invalid `sub` before calling STS, and when STS returns no
 * credentials: there is no fallback to the function's own role.
 */
export async function userScope(sub: string, opts: UserScopeOptions): Promise<StoreClients> {
  const owner = assertOwnerId(sub);
  const now = opts.now ?? Date.now;
  const at = now();

  const hit = cache.get(owner);
  if (
    hit &&
    at - hit.fetchedAt < MAX_REUSE_MS &&
    hit.expiresAt - at >= LONGEST_URL_SECONDS * 1000 + MARGIN_MS
  ) {
    return hit.clients;
  }

  const sts = opts.sts ?? (defaultSts ??= new STSClient({}));
  const { Credentials: c } = await sts.send(
    new AssumeRoleCommand({
      RoleArn: opts.roleArn,
      RoleSessionName: sessionName(owner),
      DurationSeconds: SESSION_SECONDS,
      Tags: [{ Key: 'sub', Value: owner }],
    }),
  );
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error('AssumeRole returned no credentials');
  }

  const credentials = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
  const clients: StoreClients = {
    dynamodb: documentClient(new DynamoDBClient({ credentials })),
    s3: new S3Client({ credentials }),
    presigner: new S3Client({ credentials, requestChecksumCalculation: 'WHEN_REQUIRED' }),
  };

  cache.delete(owner);
  cache.set(owner, { clients, fetchedAt: at, expiresAt: c.Expiration.getTime() });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return clients;
}

/**
 * Shown in CloudTrail for every call the session makes, so it names the user without
 * exposing the raw `sub`: a short hash, in the characters a session name allows
 * (`[\w+=,.@-]`, 2–64).
 */
export function sessionName(owner: string): string {
  return `user-${createHash('sha256').update(owner).digest('hex').slice(0, 32)}`;
}

/** For tests: forget every cached session. */
export function clearUserScopes(): void {
  cache.clear();
}
