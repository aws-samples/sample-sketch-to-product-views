import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineState } from '@sketch-to-product-views/contracts';
import {
  candidateKey,
  deliveryKey,
  etagFor,
  initialStages,
  inputKey,
  isOwnedKey,
  ownerKeyPrefix,
  ownerPrefix,
  revisionSegment,
  revisionStamp,
  safeFilename,
  sniffImageType,
} from '../src/store/index.js';

/**
 * Pure store logic only. Anything that talks to DynamoDB or S3 is exercised by the
 * deployed smoke path, not here — a mocked AWS client would only assert that the code
 * calls the client the way the code calls the client.
 */

test('a filename cannot escape its prefix', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('MODEL-9 front.jpg'), 'MODEL-9_front.jpg');
  assert.equal(safeFilename('.hidden'), 'hidden');
  // Never empty: an empty key segment would produce an object nobody can address.
  assert.equal(safeFilename('///'), 'file');
});

test('an upload key is unique per upload, outside any revision prefix', () => {
  const one = inputKey('user-1', 'MODEL-9', 'sketch.jpg');
  assert.match(one, /^user\/user-1\/product\/MODEL-9\/uploads\/[0-9a-f-]{36}\/sketch\.jpg$/);
  // Two uploads of the same filename must not collide: a presign happens before the
  // revision exists, so the uuid is the only thing keeping them apart.
  assert.notEqual(one, inputKey('user-1', 'MODEL-9', 'sketch.jpg'));
});

test("every key sits under its owner's prefix, and only there", () => {
  const seg = revisionSegment('2026-09-22T10:11:12.000Z', 'rev-aaa');
  for (const key of [
    inputKey('user-1', 'MODEL-9', 'sketch.jpg'),
    candidateKey('user-1', 'MODEL-9', seg, 'c1', 'image/png'),
    deliveryKey('user-1', 'MODEL-9', seg, 'MODEL-9-approved.png'),
  ]) {
    assert.ok(key.startsWith(ownerKeyPrefix('user-1')), key);
    assert.equal(isOwnedKey('user-1', key), true, key);
    assert.equal(isOwnedKey('user-2', key), false, key);
  }
  assert.equal(isOwnedKey('user-1', 'user/user-1/../user-2/x.png'), false);
  assert.equal(ownerPrefix('user-1'), 'USER#user-1#');
  for (const bad of ['', 'a/b', 'a#b', 'a b', 'a*', 'x'.repeat(129)]) {
    assert.throws(() => ownerKeyPrefix(bad), /invalid owner id/, bad);
    assert.throws(() => ownerPrefix(bad), /invalid owner id/, bad);
  }
});

test('the revision stamp is compact, colon-free and chronologically sortable', () => {
  assert.equal(revisionStamp('2026-09-22T10:11:12.345Z'), '20260922T101112Z');
  // Not a local-time rendering: the same instant expressed in another offset must compact
  // to the same UTC stamp, or two runs would sort by the writer's timezone.
  assert.equal(revisionStamp('2026-09-22T12:11:12+02:00'), '20260922T101112Z');
  assert.ok(!revisionStamp('2026-09-22T10:11:12.345Z').includes(':'));

  const earlier = revisionStamp('2026-09-22T10:11:12.000Z');
  const later = revisionStamp('2026-09-22T10:11:13.000Z');
  // Lexicographic order equals chronological order — the reason the segment is a stamp and
  // not a bare uuid. A naive `9` vs `10` month or hour would break exactly here.
  assert.ok(earlier < later);
  assert.ok(revisionStamp('2026-09-22T00:00:00Z') < revisionStamp('2026-10-01T00:00:00Z'));
  assert.ok(revisionStamp('2026-09-22T09:00:00Z') < revisionStamp('2026-09-22T10:00:00Z'));

  // An unparseable value must not throw mid-delivery, and must not collide with a real
  // stamp; the revision id after it still makes the segment unique.
  assert.equal(revisionStamp('not a date'), 'undated');
});

test('two revisions of one product get different segments', () => {
  const first = revisionSegment('2026-09-22T10:11:12.000Z', 'rev-aaa');
  const second = revisionSegment('2026-09-22T11:00:00.000Z', 'rev-bbb');
  assert.equal(first, '20260922T101112Z-rev-aaa');
  assert.notEqual(first, second);
  assert.ok(first < second);
  // Same instant, different revision: still distinct, because the id is in the segment.
  assert.notEqual(first, revisionSegment('2026-09-22T10:11:12.000Z', 'rev-bbb'));
});

test('a candidate key takes its extension from the content type', () => {
  const seg = revisionSegment('2026-09-22T10:11:12.000Z', 'rev-aaa');
  assert.equal(
    candidateKey('user-1', 'MODEL-9', seg, 'c1', 'image/png'),
    `user/user-1/product/MODEL-9/${seg}/candidates/c1.png`,
  );
  assert.match(candidateKey('user-1', 'MODEL-9', seg, 'c1', 'image/jpeg'), /\/c1\.jpg$/);
  assert.match(candidateKey('user-1', 'MODEL-9', seg, 'c1', 'image/webp'), /\/c1\.webp$/);
  assert.match(
    deliveryKey('user-1', 'MODEL-9', seg, 'final asset.glb'),
    /\/delivery\/final_asset\.glb$/,
  );
});

test('a second approved run cannot overwrite the first run delivered asset', () => {
  // The exact bug this layout fixes: the delivery filename is derived from the product id,
  // so the two keys differ only by the revision segment.
  const filename = 'MODEL-9-approved.png';
  const first = deliveryKey(
    'user-1',
    'MODEL-9',
    revisionSegment('2026-09-22T10:11:12.000Z', 'rev-aaa'),
    filename,
  );
  const second = deliveryKey(
    'user-1',
    'MODEL-9',
    revisionSegment('2026-09-23T08:00:00.000Z', 'rev-bbb'),
    filename,
  );
  assert.notEqual(first, second);
  assert.ok(first < second);
  assert.match(
    first,
    /^user\/user-1\/product\/MODEL-9\/20260922T101112Z-rev-aaa\/delivery\/MODEL-9-approved\.png$/,
  );
});

test('magic bytes are trusted, declared content types are not', () => {
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(
    sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/png',
  );
  assert.equal(
    sniffImageType(new Uint8Array(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))),
    'image/webp',
  );
  // A PDF renamed to .png must not pass: this is the gate in front of upload validation.
  assert.equal(sniffImageType(new Uint8Array(Buffer.from('%PDF-1.7'))), undefined);
  assert.equal(sniffImageType(new Uint8Array([])), undefined);
});

test('every stage starts pending, so the rail renders before the pipeline has run', () => {
  const stages = initialStages();
  assert.equal(Object.keys(stages).length, 9);
  assert.ok(Object.values(stages).every((s) => s.status === 'pending' && s.attempt === 0));
});

test('the ETag changes when a stage event is appended', () => {
  const base: PipelineState = {
    revisionId: 'r1',
    productId: 'MODEL-9',
    revision: 1,
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    modelId: 'gpt-image-flare',
    attemptBudget: 3,
    attempt: 0,
    inputs: [],
    stages: initialStages(),
    candidates: [],
    events: [],
  };

  const withEvent: PipelineState = {
    ...base,
    updatedAt: '2026-01-01T00:00:01.000Z',
    events: [{ seq: 1, revisionId: 'r1', stage: 'upload', status: 'passed', at: base.updatedAt }],
  };

  assert.equal(etagFor(base), etagFor({ ...base }));
  assert.notEqual(etagFor(base), etagFor(withEvent));
  // Weak, because the body is re-serialised with freshly presigned URLs on every read.
  assert.match(etagFor(base), /^W\/"[0-9a-f]{40}"$/);
});
