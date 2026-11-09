import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centreOn, fitRoom, heightFitZoom, MAX_ZOOM } from '../src/lib/camera.js';

/** The graph fitted to the pane's height, and where the camera sits when it is then too wide. */

const BOUNDS = { x: 0, y: 0, width: 1400, height: 800 };

test('the zoom fits the graph to the pane height, capped at the maximum zoom', () => {
  assert.equal(heightFitZoom(BOUNDS, 1000), fitRoom(1000) / 800);
  assert.equal(heightFitZoom({ ...BOUNDS, height: 100 }, 1000), MAX_ZOOM);
});

test('an axis the graph fits is centred on the graph, whatever the target', () => {
  const centre = centreOn({ x: 100, y: 50 }, BOUNDS, { width: 2000, height: 1000 }, 1);
  assert.deepEqual(centre, { x: 700, y: 400 });
});

test('an axis the graph overflows follows the target, clamped to the graph edges', () => {
  const pane = { width: 600, height: 1000 };
  // 600px at zoom 1 shows 300 either side of the centre.
  assert.equal(centreOn({ x: 700, y: 0 }, BOUNDS, pane, 1).x, 700);
  assert.equal(centreOn({ x: 50, y: 0 }, BOUNDS, pane, 1).x, 300);
  assert.equal(centreOn({ x: 1390, y: 0 }, BOUNDS, pane, 1).x, 1100);
});
