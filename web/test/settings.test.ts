import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingChoices, settingsToSend } from '../src/lib/settings.js';

const params = [
  {
    key: 'size',
    default: '2336x3504',
    options: [{ value: '2336x3504' }, { value: '1024x1024' }, { value: '1536x1024' }],
  },
  { key: 'quality', default: 'max', options: [{ value: 'medium' }, { value: 'max' }] },
  { key: 'complexity', default: 'high', options: [{ value: 'low' }, { value: 'high' }] },
  { key: 'output_format', default: 'png', options: [{ value: 'png' }] },
];

test('the form offers size, quality and complexity, defaulting to the deployment then the registry', () => {
  const choices = settingChoices(params, { quality: 'medium', attemptBudget: 2 });
  assert.deepEqual(
    choices.map((c) => [c.key, c.defaultValue]),
    [
      ['size', '2336x3504'],
      ['quality', 'medium'],
      ['complexity', 'high'],
    ],
  );
});

test('a deployment value the model does not offer falls back to the registry default', () => {
  const [size] = settingChoices(params, { size: '9999x9999', attemptBudget: 2 });
  assert.equal(size.defaultValue, '2336x3504');
});

test('a model without a setting offers none for it', () => {
  assert.deepEqual(
    settingChoices([params[0]], undefined).map((c) => c.key),
    ['size'],
  );
});

test('only changed values are sent, so an untouched form records no settings', () => {
  const choices = settingChoices(params, { attemptBudget: 2 });
  assert.equal(settingsToSend(choices, {}, 2, 2), undefined);
  assert.equal(settingsToSend(choices, { size: '2336x3504' }, 2, 2), undefined);
  assert.deepEqual(settingsToSend(choices, { size: '1536x1024', quality: 'medium' }, 1, 2), {
    size: '1536x1024',
    quality: 'medium',
    attemptBudget: 1,
  });
});
