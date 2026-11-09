import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ProductSpec } from '@sketch-to-product-views/contracts';
import {
  TRIAGE_PROMPT_VERSION,
  changeableAttributes,
  readTriage,
  triageFeedback,
  triageMessage,
} from '../src/analyse/feedback-triage.js';
import { AnalysisMalformedError } from '../src/analyse/sketch-analyser.js';
import type { LiteLLMConfig } from '../src/litellm/client.js';

const spec: ProductSpec = {
  model: 'MODEL-10',
  productType: { value: 'lounge chair', provenance: 'supplied' },
  parts: [{ name: 'backrest', description: 'curved, slatted', location: 'rear' }],
  details: [{ description: 'brass plaque', location: 'left armrest', view: 'front' }],
};

function gateway(content: string) {
  const bodies: Record<string, unknown>[] = [];
  const config: LiteLLMConfig = {
    baseUrl: 'https://gateway.test',
    apiKey: async () => 'sk-test',
    timeoutMs: 1000,
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }),
      );
    }) as typeof fetch,
  };
  return { config, bodies };
}

test('one text-only call, structured, with the comment as data', async () => {
  const gw = gateway(
    JSON.stringify({
      views: [{ view: 'back', request: 'Add a centred handle.' }],
      attributes: ['parts', 'not_an_attribute'],
    }),
  );
  const result = await triageFeedback(
    { notes: 'Ajouter une poignée "au dos"', spec, modelId: 'analyser-luna-litellm' },
    { litellm: gw.config },
  );

  assert.deepEqual(result.views, [{ view: 'back', request: 'Add a centred handle.' }]);
  assert.deepEqual(result.attributes, ['parts'], 'a name outside the list is dropped');
  assert.equal(result.promptVersion, TRIAGE_PROMPT_VERSION);
  const body = gw.bodies[0] as {
    messages: { role: string; content: { type: string; text: string }[] }[];
    response_format: { json_schema: { name: string; strict: boolean } };
  };
  assert.equal(body.response_format.json_schema.name, 'feedback_triage');
  assert.equal(body.response_format.json_schema.strict, true);
  const user = body.messages[1].content;
  assert.deepEqual(
    user.map((p) => p.type),
    ['text'],
    'no image: the comment names parts, which is words',
  );
  assert.match(user[0].text, /Product: lounge chair\./);
  assert.match(user[0].text, /- backrest: curved, slatted, rear/);
  assert.match(user[0].text, /- brass plaque, left armrest \(front\)/);
  assert.match(
    user[0].text,
    /Aspects: object_type, shape, proportions, parts, color, material, pattern\./,
  );
  assert.doesNotMatch(user[0].text, /presentation/);
  assert.ok(user[0].text.includes(JSON.stringify('Ajouter une poignée "au dos"')));
});

test('requests come back in view order, two for one view joined', () => {
  const { views } = readTriage(
    JSON.stringify({
      attributes: [],
      views: [
        { view: 'right', request: 'Longer handle.' },
        { view: 'front', request: 'Wider lid.' },
        { view: 'right', request: ' Darker. ' },
      ],
    }),
    { notes: 'notes', spec },
  );
  assert.deepEqual(views, [
    { view: 'front', request: 'Wider lid.' },
    { view: 'right', request: 'Longer handle. Darker.' },
  ]);
});

test('an answer that names no view sends the comment as written to all four', () => {
  assert.deepEqual(
    readTriage('{"views": [], "attributes": []}', { notes: ' Plus court. ', spec }).views.map(
      (v) => `${v.view}: ${v.request}`,
    ),
    ['front: Plus court.', 'back: Plus court.', 'left: Plus court.', 'right: Plus court.'],
  );
});

test('an answer off the schema is malformed, so the step retries it', () => {
  assert.throws(
    () =>
      readTriage('{"views": [{"view": "top", "request": "x"}], "attributes": []}', {
        notes: 'n',
        spec,
      }),
    AnalysisMalformedError,
  );
  assert.throws(() => readTriage('not json', { notes: 'n', spec }), AnalysisMalformedError);
});

test('a spec with no product type is still a product', () => {
  assert.match(triageMessage({ notes: 'x', spec: { model: 'A' } }), /^Product: product\./);
});

test('an unreadable answer is asked again, then the comment goes to every view as written', async () => {
  const gw = gateway('Sure, here is how I would split it.');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const result = await triageFeedback(
      { notes: ' Make it rounder. ', spec, modelId: 'analyser-luna-litellm' },
      { litellm: gw.config },
    );
    assert.equal(gw.bodies.length, 2, 'one retry before falling back');
    assert.deepEqual(
      result.views.map((v) => [v.view, v.request]),
      [
        ['front', 'Make it rounder.'],
        ['back', 'Make it rounder.'],
        ['left', 'Make it rounder.'],
        ['right', 'Make it rounder.'],
      ],
    );
    assert.deepEqual(result.attributes, []);
  } finally {
    console.warn = warn;
  }
});

test("the aspects a note can change are the critic's, all but the presentation", () => {
  assert.deepEqual(changeableAttributes(), [
    'object_type',
    'shape',
    'proportions',
    'parts',
    'color',
    'material',
    'pattern',
  ]);
});

test('on Bedrock with a guardrail, only the comment is guardContent', async () => {
  const inputs: ConverseCommand['input'][] = [];
  const bedrockClientFor = () => ({
    send: async (command: ConverseCommand) => {
      inputs.push(command.input);
      return {
        stopReason: 'end_turn',
        output: {
          message: {
            role: 'assistant',
            content: [{ text: JSON.stringify({ views: [], attributes: [] }) }],
          },
        },
      };
    },
  });
  await triageFeedback(
    { notes: 'Make the "backrest" taller', spec, modelId: 'analyser-luna-bedrock' },
    { bedrockClientFor: bedrockClientFor as never, guardrail: { id: 'gr1', version: '1' } },
  );
  const content = inputs[0].messages![0].content!;
  const guarded = content.flatMap((b) => (b.guardContent?.text ? [b.guardContent.text.text] : []));
  assert.deepEqual(guarded, [JSON.stringify('Make the "backrest" taller')]);
  assert.ok(content[0].text?.startsWith('Product: lounge chair.'), 'the product lines are plain');
  assert.equal(inputs[0].guardrailConfig?.guardrailIdentifier, 'gr1');
});
