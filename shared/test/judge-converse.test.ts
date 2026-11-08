import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { GuardrailBlockedError } from '../src/guardrail/index.js';
import { resolveModel } from '../src/registry/index.js';
import { aspectDef } from '@sketch-to-product-views/contracts';
import {
  MAX_TURNS,
  bedrockJsonSchema,
  checkRequests,
  comparisonRequest,
  comparisonSchema,
  createConverseRunner,
  type CriticRequest,
} from '../src/qc/judge/index.js';

const entry = resolveModel('critic');
const schema = comparisonSchema([aspectDef('color')], true);
const valid = {
  aspects: {
    color: { reference: 'green', observed: 'green', reason: 'both green', answer: 'same' },
  },
  parts: [
    { part: 'lid', reference: 'a lid', observed: 'a lid', reason: 'same lid', answer: 'same' },
  ],
  image: { usable: true, imageQuality: 0.9, problems: [] },
};

const request = (over: Partial<CriticRequest> = {}): CriticRequest => ({
  purpose: 'comparison',
  entry,
  system: 'Compare.',
  images: [
    { label: 'Sketch', image: { bytes: new Uint8Array([1, 2]), format: 'png' } },
    { label: 'Generated image', image: { bytes: new Uint8Array([3]), format: 'jpeg' } },
  ],
  schema,
  ...over,
});

const answer = (text: string, stopReason = 'end_turn'): ConverseCommandOutput => ({
  $metadata: {},
  stopReason: stopReason as ConverseCommandOutput['stopReason'],
  output: { message: { role: 'assistant', content: [{ text }] } },
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  metrics: { latencyMs: 1 },
});

/** Answers in order, and records each request's input. */
function fakeClient(answers: (ConverseCommandOutput | Error)[]) {
  const inputs: ConverseCommand['input'][] = [];
  const regions: string[] = [];
  const clientFor = (region: string) => {
    regions.push(region);
    return {
      send: async (command: ConverseCommand) => {
        // Copied: the runner keeps appending to the same messages array.
        inputs.push(structuredClone(command.input));
        const next = answers.shift();
        if (!next) throw new Error('no answer left');
        if (next instanceof Error) throw next;
        return next;
      },
    };
  };
  return { clientFor: clientFor as never, inputs, regions };
}

test('structured output: sends the labelled images and a Bedrock-safe schema, returns the parsed answer', async () => {
  const fake = fakeClient([answer(JSON.stringify(valid))]);
  const result = await createConverseRunner(fake)(request());

  assert.deepEqual(result, { output: valid, usage: { inputTokens: 100, outputTokens: 20 } });
  assert.deepEqual(fake.regions, [entry.region]);
  const [input] = fake.inputs;
  assert.equal(input.modelId, entry.bedrockModelId);
  const content = input.messages?.[0].content ?? [];
  assert.deepEqual(
    content.map((b) => b.text ?? b.image?.format),
    ['Sketch:', 'png', 'Generated image:', 'jpeg'],
  );
  assert.equal(input.inferenceConfig?.temperature, 0);
  assert.equal(input.inferenceConfig?.maxTokens, 4096);
  assert.equal(input.outputConfig?.textFormat?.type, 'json_schema');
  const sent = input.outputConfig?.textFormat?.structure?.jsonSchema?.schema ?? '';
  assert.doesNotMatch(sent, /"(minimum|maximum|maxItems|\$schema)"/);
  assert.match(sent, /"additionalProperties":false/);
  assert.doesNotMatch(sent, /anyOf/, 'no union: Bedrock allows 16 per schema');
});

test('a request can raise the token budget above the entry, never lower it', async () => {
  const fake = fakeClient([answer(JSON.stringify(valid)), answer(JSON.stringify(valid))]);
  await createConverseRunner(fake)(request({ minOutputTokens: 6000 }));
  await createConverseRunner(fake)(request({ minOutputTokens: 10 }));
  assert.deepEqual(
    fake.inputs.map((i) => i.inferenceConfig?.maxTokens),
    [6000, 4096],
  );
});

test('a request can set its own temperature over the entry', async () => {
  const fake = fakeClient([answer(JSON.stringify(valid))]);
  await createConverseRunner(fake)(request({ temperature: 0.7 }));
  assert.equal(fake.inputs[0].inferenceConfig?.temperature, 0.7);
});

test('bedrockJsonSchema drops unsupported keywords, keeps minItems 0 or 1', () => {
  assert.deepEqual(
    bedrockJsonSchema({
      $schema: 'x',
      type: 'object',
      properties: {
        a: { type: 'number', minimum: 0, maximum: 1 },
        b: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', maxLength: 3 } },
        c: { type: 'array', minItems: 2 },
      },
    }),
    {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'array', minItems: 1, items: { type: 'string' } },
        c: { type: 'array' },
      },
    },
  );
});

test('without structured output: the schema goes in the system prompt, a fenced answer is read', async () => {
  const fake = fakeClient([answer('```json\n' + JSON.stringify(valid) + '\n```')]);
  const result = await createConverseRunner(fake)(
    request({ entry: { ...entry, structuredOutput: false } }),
  );

  assert.deepEqual(result.output, valid);
  const [input] = fake.inputs;
  assert.equal(input.outputConfig, undefined);
  assert.match(input.system?.[0].text ?? '', /matching this JSON Schema:\n\{/);
});

test('a schema violation gets a correction turn, and the usage adds up', async () => {
  const wrong = {
    ...valid,
    aspects: { color: { ...valid.aspects.color, answer: 'maybe' } },
  };
  const fake = fakeClient([answer(JSON.stringify(wrong)), answer(JSON.stringify(valid))]);
  const result = await createConverseRunner(fake)(request());

  assert.deepEqual(result, { output: valid, usage: { inputTokens: 200, outputTokens: 40 } });
  const messages = fake.inputs[1].messages ?? [];
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(messages[1].content?.[0].text, JSON.stringify(wrong));
  assert.match(messages[2].content?.[0].text ?? '', /aspects\.color\.answer/);
});

test(`after ${MAX_TURNS} wrong answers the reading fails with the issues as its cause`, async () => {
  const fake = fakeClient(Array.from({ length: MAX_TURNS + 1 }, () => answer('not json')));
  await assert.rejects(createConverseRunner(fake)(request()), (err: Error) => {
    assert.equal(err.message, `${entry.id}: comparison did not match its schema`);
    assert.ok(err.cause instanceof Error);
    return true;
  });
  assert.equal(fake.inputs.length, MAX_TURNS);
});

test('a stop other than end_turn is no structured output, never corrected', async () => {
  const fake = fakeClient([answer('{"aspects":', 'max_tokens'), answer(JSON.stringify(valid))]);
  await assert.rejects(createConverseRunner(fake)(request()), {
    message: `${entry.id}: comparison gave no structured output (max_tokens)`,
  });
  assert.equal(fake.inputs.length, 1);
});

test('an SDK error passes through unchanged', async () => {
  const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
  const fake = fakeClient([throttled]);
  await assert.rejects(createConverseRunner(fake)(request()), throttled);
});

const GUARDRAIL = { id: 'gr123', version: '2' };

test('without a guardrail, no guardrailConfig and the system prompt is one text block', async () => {
  const fake = fakeClient([answer(JSON.stringify(valid))]);
  await createConverseRunner({ ...fake, guardrail: null })(
    request({ system: 'Facts: "IVORY".', guarded: ['"IVORY"'] }),
  );
  const [input] = fake.inputs;
  assert.equal(input.guardrailConfig, undefined);
  assert.deepEqual(input.system, [{ text: 'Facts: "IVORY".' }]);
});

test('with a guardrail, only the supplied text in the system prompt is guardContent', async () => {
  const fake = fakeClient([answer(JSON.stringify(valid))]);
  await createConverseRunner({ ...fake, guardrail: GUARDRAIL })(
    request({ system: 'Compare.\n- colour: "IVORY"\nEnd.', guarded: ['"IVORY"'] }),
  );
  const [input] = fake.inputs;
  assert.deepEqual(input.guardrailConfig, {
    guardrailIdentifier: 'gr123',
    guardrailVersion: '2',
    trace: 'disabled',
  });
  assert.deepEqual(input.system, [
    { text: 'Compare.\n- colour: ' },
    { guardContent: { text: { text: '"IVORY"' } } },
    { text: '\nEnd.' },
  ]);
  // Labels and images are never wrapped.
  assert.ok((input.messages?.[0].content ?? []).every((b) => b.guardContent === undefined));
  assert.ok(input.outputConfig?.textFormat, 'structured output is kept');
});

test('a guardrail block is a GuardrailBlockedError, never a correction turn', async () => {
  const fake = fakeClient([answer('Blocked.', 'guardrail_intervened')]);
  await assert.rejects(
    () => createConverseRunner({ ...fake, guardrail: GUARDRAIL })(request()),
    (error: Error) =>
      error instanceof GuardrailBlockedError &&
      error.message === 'Critic comparison call: blocked by the content guardrail.',
  );
  assert.equal(fake.inputs.length, 1);
});

test('the comparison and the request check mark the facts and the requests as user text', async () => {
  const spec = {
    model: 'M',
    colorDescription: { value: 'IVORY', provenance: 'supplied' as const },
  };
  const image = { bytes: new Uint8Array([1]), format: 'png' as const };
  const compared = comparisonRequest(
    entry,
    { spec, view: 'front' },
    { sketch: image, candidate: image },
  );
  assert.deepEqual(compared.guarded, ['"IVORY"']);
  assert.ok(compared.system.includes('"IVORY"'));

  const seen: CriticRequest[] = [];
  await checkRequests(image, ['Make the handle longer.'], {
    entry,
    runner: async (r) => {
      seen.push(r);
      return {
        output: { requests: [{ applied: true, confidence: 1, note: 'ok' }] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  });
  assert.deepEqual(seen[0].guarded, ['"Make the handle longer."']);
  assert.ok(seen[0].system.includes('"Make the handle longer."'));
});
