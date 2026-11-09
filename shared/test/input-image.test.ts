import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { checkInputImage, checkInputSize } from '../src/image/input.js';

/** Flat fill of one grey level. */
const flat = (level: number, width = 128, height = 128) =>
  sharp({ create: { width, height, channels: 3, background: { r: level, g: level, b: level } } })
    .png()
    .toBuffer();

test('a well-formed image passes package validation, with its size and dimensions reported', async () => {
  const bytes = await flat(200, 1024, 1024);
  const result = await checkInputImage(bytes);
  assert.deepEqual(result, {
    ok: true,
    issues: [],
    width: 1024,
    height: 1024,
    format: 'png',
    sizeBytes: bytes.byteLength,
  });
});

test('an image wider than 8000 px is rejected, naming the limit', async () => {
  const result = await checkInputImage(await flat(200, 8001, 10));
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /8001 px wide, the limit is 8000 px per side/);
});

test('an image taller than 8000 px is rejected, naming the limit', async () => {
  const result = await checkInputImage(await flat(200, 10, 8001));
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /8001 px tall, the limit is 8000 px per side/);
});

test('jpeg and webp are accepted', async () => {
  const base = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } });
  assert.equal((await checkInputImage(await base().jpeg().toBuffer())).ok, true);
  assert.equal((await checkInputImage(await base().webp().toBuffer())).ok, true);
});

test('a gif is rejected as an unsupported format', async () => {
  const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } })
    .gif()
    .toBuffer();
  const result = await checkInputImage(gif);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /unsupported format: gif/);
});

test('no minimum side or aspect ratio: tiny and very wide images pass', async () => {
  assert.equal((await checkInputImage(await flat(200, 32, 32))).ok, true);
  assert.equal((await checkInputImage(await flat(200, 1000, 100))).ok, true);
});

test('the size limit is 3.75 MB, read as 3,750,000 bytes', () => {
  assert.equal(checkInputSize(3_750_000), undefined);
  assert.match(checkInputSize(3_750_001) ?? '', /the limit is 3\.75 MB/);
});

test('an undecodable input throws', async () => {
  await assert.rejects(
    () => checkInputImage(Buffer.from('not an image at all')),
    /could not be decoded/,
  );
});
