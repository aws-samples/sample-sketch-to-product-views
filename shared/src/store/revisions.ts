import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { assertOwnerId } from './owner.js';
import { documentClient, scopedClients } from './scope.js';
import {
  STAGE_IDS,
  type PipelineState,
  type StageDetail,
  type StageEvent,
  type StageId,
  type StageRun,
  type StageStatus,
} from '@sketch-to-product-views/contracts';

/**
 * DynamoDB revision store, behind the same two calls
 * the pipeline uses: `patch()` and `emit()`.
 *
 * Layout — one partition per revision, so reading a run is a single Query:
 *
 *   pk = USER#{owner}#REV#{revisionId}   sk = META          the revision, minus its events
 *   pk = USER#{owner}#REV#{revisionId}   sk = EVENT#{seq}   one item per stage transition
 *
 * The partition key starts with the owner's `sub`, so a revision can only be addressed by
 * the user who owns it: a caller builds the key from their own verified `sub` and finds
 * nothing under anyone else's. It is also what lets IAM enforce the same boundary, with a
 * `dynamodb:LeadingKeys` condition on `USER#${aws:PrincipalTag/sub}#*` (infra/modules/api).
 *
 * `seq` is zero-padded to six digits so lexicographic order equals numeric order — an
 * unpadded `EVENT#10` would sort before `EVENT#9` and the UI would render the run out
 * of order.
 */

const TABLE = () => {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  return table;
};

let doc: DynamoDBDocumentClient | undefined;

/** The current user scope's client (the API), else the function's own (the pipeline). */
function client(): DynamoDBDocumentClient {
  const scoped = scopedClients();
  if (scoped) return scoped.dynamodb;
  doc ??= documentClient(new DynamoDBClient({}));
  return doc;
}

/**
 * Which revision, and whose. Every read and write takes both, because the owner is part of
 * the key: there is no way to address a revision by its id alone.
 */
export interface RevisionRef {
  owner: string;
  revisionId: string;
}

const revKey = (ref: RevisionRef) => `${ownerPrefix(ref.owner)}REV#${ref.revisionId}`;

/** `USER#{owner}#`: the leading part of every partition key the owner can reach. */
export function ownerPrefix(owner: string): string {
  return `USER#${assertOwnerId(owner)}#`;
}
const eventKey = (seq: number) => `EVENT#${String(seq).padStart(6, '0')}`;

/** Everything in a PipelineState except the event log, which lives in its own items. */
type RevisionMeta = Omit<PipelineState, 'events'>;

export function initialStages(): Record<StageId, StageRun> {
  return Object.fromEntries(
    STAGE_IDS.map((id) => [id, { status: 'pending' as StageStatus, attempt: 0 }]),
  ) as Record<StageId, StageRun>;
}

export interface CreateRevisionInput {
  productId: string;
  inputs: PipelineState['inputs'];
  productMetadata?: PipelineState['productMetadata'];
  modelId: string;
  attemptBudget: number;
  settings?: PipelineState['settings'];
  /**
   * The submitter's verified JWT subject. Required here rather than optional so a new
   * call site cannot quietly create an unowned — and therefore unauthorizable — revision.
   */
  owner: string;
}

export async function createRevision(input: CreateRevisionInput): Promise<RevisionMeta> {
  const now = new Date().toISOString();
  const meta: RevisionMeta = {
    revisionId: randomUUID(),
    productId: input.productId,
    // Display-only ordinal; see `pipelineStateSchema.revision`. Artifact keys are prefixed
    // by `revisionSegment(createdAt, revisionId)`, never by this number.
    revision: 1,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    owner: input.owner,
    modelId: input.modelId,
    attemptBudget: input.attemptBudget,
    ...(input.settings ? { settings: input.settings } : {}),
    attempt: 0,
    inputs: input.inputs,
    ...(input.productMetadata ? { productMetadata: input.productMetadata } : {}),
    stages: initialStages(),
    candidates: [],
  };

  await client().send(
    new PutCommand({
      TableName: TABLE(),
      Item: {
        pk: revKey({ owner: input.owner, revisionId: meta.revisionId }),
        sk: 'META',
        ...meta,
        seq: 0,
      },
      // A revision id is a fresh UUID, so a collision means something is badly wrong
      // and must not silently overwrite an existing run.
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );

  return meta;
}

/**
 * Reads the whole run: meta plus its events, assembled into the shape the SPA polls.
 * One Query, because events share the revision's partition.
 */
export async function getRevision(ref: RevisionRef): Promise<PipelineState | undefined> {
  // A Query stops at 1 MB regardless of Limit. A long run's event log can cross that, and
  // a silently truncated log would render as a run that never finished, so follow the
  // continuation key rather than trusting the first page.
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await client().send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': revKey(ref) },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const metaItem = items.find((i) => i.sk === 'META');
  if (!metaItem) return undefined;

  const { pk: _pk, sk: _sk, seq: _seq, reviewCallbackId: _cb, ...meta } = metaItem;

  const events = items
    .filter((i) => typeof i.sk === 'string' && i.sk.startsWith('EVENT#'))
    .map((i) => i.event as StageEvent)
    .sort((a, b) => a.seq - b.seq);

  return { ...(meta as RevisionMeta), events };
}

/** Shallow-merges a patch and bumps `updatedAt`. Does not touch stage status. */
export async function patchRevision(
  ref: RevisionRef,
  delta: Partial<Omit<PipelineState, 'revisionId' | 'stages' | 'events'>>,
): Promise<void> {
  const fields = { ...delta, updatedAt: new Date().toISOString() };
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);

  await client().send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { pk: revKey(ref), sk: 'META' },
      UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#f${i}`, k])),
      ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

/**
 * Records a stage transition. **The only way stage status ever changes.**
 *
 * The append-only event and the `stages` projection are written from the same call, so
 * they cannot drift — the UI is a projection of this log and nothing else.
 *
 * The sequence number comes from an atomic `ADD seq 1` on the META item, so two writers
 * can never mint the same seq. In the durable pipeline each call is wrapped in a step,
 * which is what makes the pair of writes idempotent across a replay.
 */
export async function emit(
  ref: RevisionRef,
  stage: StageId,
  status: StageStatus,
  opts: {
    message?: string;
    attempt?: number;
    view?: StageEvent['view'];
    stubbed?: boolean;
    detail?: StageDetail;
  } = {},
): Promise<StageEvent> {
  const at = new Date().toISOString();

  const bumped = await client().send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { pk: revKey(ref), sk: 'META' },
      UpdateExpression: 'ADD #seq :one SET #updatedAt = :at, #stages.#stage = :run',
      ExpressionAttributeNames: {
        '#seq': 'seq',
        '#updatedAt': 'updatedAt',
        '#stages': 'stages',
        '#stage': stage,
      },
      ExpressionAttributeValues: {
        ':one': 1,
        ':at': at,
        ':run': runFor(status, at, opts),
      },
      ConditionExpression: 'attribute_exists(pk)',
      ReturnValues: 'UPDATED_NEW',
    }),
  );

  const seq = Number(bumped.Attributes?.seq ?? 0);

  const event: StageEvent = {
    seq,
    revisionId: ref.revisionId,
    stage,
    status,
    at,
    ...(opts.message ? { message: opts.message } : {}),
    ...(opts.attempt ? { attempt: opts.attempt } : {}),
    ...(opts.view ? { view: opts.view } : {}),
    ...(opts.stubbed ? { stubbed: true } : {}),
    // Only on the event, never on the `stages` projection: the projection is "where is this
    // stage now", and a detail belongs to the one transition that produced it.
    ...(opts.detail ? { detail: opts.detail } : {}),
  };

  await client().send(
    new PutCommand({
      TableName: TABLE(),
      Item: { pk: revKey(ref), sk: eventKey(seq), event },
    }),
  );

  return event;
}

/**
 * A stage run is rebuilt from the transition rather than merged with what is stored,
 * because a conditional read-modify-write here would reintroduce the race that the
 * atomic `ADD` above removes. `startedAt` is therefore only set on `running`, which is
 * the transition every stage actually makes first.
 */
function runFor(
  status: StageStatus,
  at: string,
  opts: { message?: string; attempt?: number; stubbed?: boolean },
): StageRun {
  return {
    status,
    attempt: opts.attempt ?? 0,
    ...(opts.message ? { message: opts.message } : {}),
    ...(status === 'running' ? { startedAt: at } : { endedAt: at }),
    ...(opts.stubbed ? { stubbed: true } : {}),
  };
}

/**
 * The human review gate. The pipeline parks on a durable callback and stores its token here;
 * the API reads it back to resolve the wait. Held apart from `PipelineState` on purpose:
 * it is an internal handle and must never reach the browser.
 */
export async function setReviewCallbackId(ref: RevisionRef, callbackId: string): Promise<void> {
  await client().send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { pk: revKey(ref), sk: 'META' },
      UpdateExpression: 'SET reviewCallbackId = :id',
      ExpressionAttributeValues: { ':id': callbackId },
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

export async function getReviewCallbackId(ref: RevisionRef): Promise<string | undefined> {
  const result = await client().send(
    new GetCommand({
      TableName: TABLE(),
      Key: { pk: revKey(ref), sk: 'META' },
      ProjectionExpression: 'reviewCallbackId',
      ConsistentRead: true,
    }),
  );

  return result.Item?.reviewCallbackId as string | undefined;
}

/**
 * How often an unchanged run still gets a full response. The response carries presigned URLs,
 * and the SPA keeps the ones it has on a 304: changing the ETag every 10 minutes hands it
 * fresh URLs well before the 45-minute ones it holds expire (see ./scope.ts).
 */
export const URL_REFRESH_MS = 10 * 60_000;

/** Weak ETag over the state and the URL refresh window, so the SPA can poll with `If-None-Match`. */
export function etagFor(state: PipelineState, now: number = Date.now()): string {
  const window = Math.floor(now / URL_REFRESH_MS);
  const hash = createHash('sha1')
    .update(`${state.updatedAt}:${state.events.length}:${state.status}:${window}`)
    .digest('hex');
  return `W/"${hash}"`;
}
