import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeImageUrl } from '../src/lib/image-url.js';

test('presigned https URLs and blob previews are shown', () => {
  assert.equal(safeImageUrl('https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=1'), 'https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=1');
  assert.equal(safeImageUrl('blob:https://example.com/0f1e'), 'blob:https://example.com/0f1e');
});

test('script, data and unparsable URLs are refused', () => {
  for (const src of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'http://example.com/a.png', 'not a url']) {
    assert.equal(safeImageUrl(src), undefined, src);
  }
});
