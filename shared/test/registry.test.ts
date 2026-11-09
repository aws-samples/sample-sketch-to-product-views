import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  allModels,
  defaultFor,
  deployedModel,
  modelEntrySchema,
  modelById,
  modelsByCategory,
  resolveModel,
  selectParam,
  toProviderBody,
} from '../src/registry/index.js';

const validEntry = {
  id: 'probe',
  name: 'Probe',
  category: 'critic',
  bedrockModelId: 'us.example.model-v1:0',
  region: 'us-east-1',
  residency: ['us-east-1'],
  lifecycle: 'active',
  requiredInputs: ['prompt'],
  acceptsInputs: ['prompt'],
};

test('every shipped model is active — legacy models are not permitted', () => {
  for (const model of allModels()) {
    assert.equal(model.lifecycle, 'active', `${model.id} is ${model.lifecycle}`);
  }
});

test('the schema rejects a legacy model outright', () => {
  const result = modelEntrySchema.safeParse({ ...validEntry, lifecycle: 'legacy' });
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /legacy models are not permitted/);
});

test('residency must include the entry Region', () => {
  const result = modelEntrySchema.safeParse({ ...validEntry, residency: ['us-west-2'] });
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /residency must include/);
});

test('Region is carried on the entry, so no caller has to choose an endpoint', () => {
  assert.equal(modelById('analyser-luna-bedrock').region, 'us-east-1');
  assert.equal(defaultFor('critic').region, 'us-east-1');
  assert.ok(defaultFor('critic').residency.every((r) => r.startsWith('us-')));
});

test('the registry carries two critics and exactly one of them is the default', () => {
  const critics = allModels().filter((m) => m.category === 'critic');

  assert.deepEqual(critics.map((m) => m.id).sort(), ['critic-nova-pro', 'critic-sonnet']);
  assert.equal(critics.filter((m) => m.isDefault).length, 1);
});

test('resolveModel still picks Sonnet as the critic when no id is given', () => {
  assert.equal(resolveModel('critic').id, 'critic-sonnet');
});

test('resolveModel returns Nova Pro when asked for it by id, on the US profile', () => {
  const entry = resolveModel('critic', 'critic-nova-pro');

  assert.equal(entry.bedrockModelId, 'us.amazon.nova-pro-v1:0');
  assert.equal(entry.region, 'us-east-1');
  assert.ok(entry.residency.every((r) => r.startsWith('us-')));
});

test('every Bedrock entry is on a US geo profile entered from us-east-1', () => {
  const bedrock = allModels().filter((m) => m.provider === 'bedrock');
  assert.ok(bedrock.length > 0);
  for (const entry of bedrock) {
    assert.match(entry.bedrockModelId, /^us\./, entry.id);
    assert.equal(entry.region, 'us-east-1', entry.id);
    assert.deepEqual(
      [...entry.residency].sort(),
      ['us-east-1', 'us-east-2', 'us-west-2'],
      entry.id,
    );
  }
});

test('an image-control entry cannot be served by Bedrock: there is no adapter', () => {
  const result = modelEntrySchema.safeParse({ ...validEntry, category: 'image-control' });
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0].message, /image-control has no Bedrock adapter/);
  assert.ok(modelsByCategory('image-control').every((m) => m.provider !== 'bedrock'));
});

// A field-mapped entry, to exercise the canonical-name -> provider-field mapping.
const fieldMapped = modelEntrySchema.parse({
  ...validEntry,
  requiredInputs: ['prompt', 'sketch'],
  acceptsInputs: ['prompt', 'sketch'],
  apiFieldMap: {
    prompt: 'prompt',
    sketch: 'image',
    control_strength: 'control_strength',
    style_preset: 'style_preset',
  },
  params: [
    { key: 'control_strength', type: 'number', label: 'Adherence', default: 0.7, min: 0, max: 1 },
    {
      key: 'style_preset',
      type: 'select',
      label: 'Style',
      default: 'photographic',
      options: [{ value: 'photographic', label: 'Photographic' }],
    },
  ],
});

test('toProviderBody renames canonical inputs to provider fields', () => {
  const body = toProviderBody(fieldMapped, {
    prompt: 'black grained calf leather tote',
    sketch: 'BASE64',
  });

  // Pipeline code says `sketch`; the provider calls it `image`.
  assert.equal(body.image, 'BASE64');
  assert.equal(body.prompt, 'black grained calf leather tote');
  assert.equal(body.control_strength, 0.7);
  assert.equal(body.style_preset, 'photographic');
  assert.ok(!('sketch' in body));
});

test('toProviderBody lets an explicit value override a declared default', () => {
  const body = toProviderBody(fieldMapped, {
    prompt: 'p',
    sketch: 'B',
    control_strength: 0.95,
  });

  assert.equal(body.control_strength, 0.95);
});

test('toProviderBody ignores prototype keys in the inputs', () => {
  const body = toProviderBody(fieldMapped, {
    prompt: 'p',
    sketch: 'B',
    __proto__: 'x',
    constructor: 'y',
    toString: 'z',
  } as unknown as Record<string, string>);

  assert.equal(Object.getPrototypeOf(body), Object.prototype);
  assert.deepEqual(Object.keys(body).sort(), ['control_strength', 'image', 'prompt', 'style_preset']);
});

test('toProviderBody drops inputs the model declares no field for', () => {
  const body = toProviderBody(fieldMapped, {
    prompt: 'p',
    sketch: 'B',
    invented_param: 'nonsense',
  });

  assert.ok(!('invented_param' in body));
});

test('toProviderBody refuses a request missing a required input', () => {
  assert.throws(
    () => toProviderBody(fieldMapped, { prompt: 'no sketch here' }),
    /missing required input "sketch"/,
  );
});

test('resolveModel refuses a model from the wrong category', () => {
  assert.throws(
    () => resolveModel('image-control', 'critic-sonnet'),
    /is critic, not image-control/,
  );
});

test('resolveModel names the known models when given an unknown id', () => {
  assert.throws(() => resolveModel('image-control', 'no-such-model'), /Known: /);
});

/**
 * Terraform names registry entries in its variable defaults and the tfvars files, so a rename in
 * one place only would deploy a pipeline that throws on its first invocation. An empty value
 * means the registry default.
 */
const TF_MODEL_VARS = {
  image_model: 'image-control',
  analyser_model: 'analyser',
  evaluation_model: 'critic',
} as const;

const envDir = join(import.meta.dirname, '../../infra/envs/dev');

test('the model ids Terraform defaults to exist in the registry, in the right category', () => {
  const tf = readFileSync(join(envDir, 'variables.tf'), 'utf8');

  for (const [name, category] of Object.entries(TF_MODEL_VARS)) {
    const block = new RegExp(`variable "${name}"[\\s\\S]*?\\n}`).exec(tf);
    assert.ok(block, `infra/envs/dev/variables.tf declares no variable "${name}"`);
    const value = /default\s*=\s*"([^"]*)"/.exec(block[0]);
    assert.ok(value, `variable "${name}" has no string default`);
    assert.equal(deployedModel(category, value[1]).category, category, name);
  }
});

test('every tfvars file names models that exist in the registry, in the right category', () => {
  const files = readdirSync(envDir).filter((f) => f.endsWith('.example.tfvars'));
  assert.ok(
    files.includes('litellm-gateway.example.tfvars'),
    'infra/envs/dev/litellm-gateway.example.tfvars is missing',
  );

  for (const file of files) {
    const tfvars = readFileSync(join(envDir, file), 'utf8');
    for (const [name, category] of Object.entries(TF_MODEL_VARS)) {
      const value = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(tfvars);
      if (!value) continue;
      assert.equal(modelById(value[1]).category, category, `${file}: ${name}`);
    }
  }
});

test('only the OpenAI-direct example selects an openai model, and its ids resolve', () => {
  const files = readdirSync(envDir).filter((f) => f.endsWith('.example.tfvars'));
  assert.ok(files.includes('openai-direct.example.tfvars'));

  for (const file of files) {
    const tfvars = readFileSync(join(envDir, file), 'utf8');
    for (const [name, category] of Object.entries(TF_MODEL_VARS)) {
      const id = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(tfvars)?.[1];
      if (!id || modelById(id).provider !== 'openai') continue;
      assert.equal(file, 'openai-direct.example.tfvars', `${file}: ${name} = ${id}`);
      assert.equal(deployedModel(category, id).id, id);
    }
  }

  const direct = readFileSync(join(envDir, 'openai-direct.example.tfvars'), 'utf8');
  const read = (name: string) => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(direct)?.[1];
  assert.equal(read('analyser_model'), 'analyser-sonnet-bedrock');
  assert.equal(read('image_model'), 'gpt-image-2.6-sunburst-openai');
  assert.equal(modelById(read('evaluation_model')!).provider, 'bedrock');
  assert.match(direct, /^openai_api_key_secret_arn\s*=/m);
  assert.doesNotMatch(direct, /^litellm_api_key_secret_arn\s*=/m);
});

test('the gateway example runs the analyser on Bedrock and the image model through the gateway', () => {
  const read = (file: string, name: string) =>
    new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(
      readFileSync(join(envDir, file), 'utf8'),
    )?.[1];

  assert.equal(modelById(read('litellm-gateway.example.tfvars', 'analyser_model')!).provider, 'bedrock');
  assert.equal(modelById(read('litellm-gateway.example.tfvars', 'image_model')!).provider, 'litellm');
});

test('deployedModel reads an empty or blank value as the category default', () => {
  assert.equal(deployedModel('analyser', undefined).id, defaultFor('analyser').id);
  assert.equal(deployedModel('analyser', '  ').id, defaultFor('analyser').id);
  assert.equal(deployedModel('analyser', 'analyser-luna-bedrock').id, 'analyser-luna-bedrock');
  assert.throws(() => deployedModel('analyser', 'critic-sonnet'), /is critic, not analyser/);
});

test('the analyser category has exactly one default, which takes images', () => {
  const entry = defaultFor('analyser');
  assert.equal(modelsByCategory('analyser').filter((m) => m.isDefault).length, 1);
  assert.ok(entry.requiredInputs.includes('images'));
});

test('the Luna analyser exists for both providers, neither the default', () => {
  const litellm = modelById('analyser-luna-litellm');
  assert.equal(litellm.provider, 'litellm');
  assert.equal(litellm.isDefault, false);
  assert.deepEqual(litellm.residency, ['litellm.example.internal']);

  const bedrock = modelById('analyser-luna-bedrock');
  assert.equal(bedrock.provider, 'bedrock');
  assert.equal(bedrock.isDefault, false);
  assert.equal(bedrock.bedrockModelId, 'us.openai.gpt-5.6-luna');
  assert.equal(bedrock.region, 'us-east-1');
  assert.deepEqual(bedrock.residency, ['us-east-1', 'us-east-2', 'us-west-2']);

  // Measured on Bedrock: Luna rejects `temperature`. The gateway entry declares neither field
  // until smoke:analyse shows the gateway accepts it for this alias.
  for (const entry of [litellm, bedrock]) {
    assert.equal(
      entry.params.some((p) => p.key === 'temperature'),
      false,
      entry.id,
    );
  }
});

test('residency "global" is allowed only for a global. inference profile on Bedrock', () => {
  const global = {
    ...validEntry,
    bedrockModelId: 'global.example.model-v1:0',
    residency: ['us-east-1', 'global'],
  };
  assert.equal(modelEntrySchema.safeParse(global).success, true);

  for (const bad of [
    { ...global, bedrockModelId: 'us.example.model-v1:0' },
    { ...global, provider: 'litellm' },
  ]) {
    const result = modelEntrySchema.safeParse(bad);
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0].message, /residency "global" is only/);
  }
});

test('the OpenAI-direct entries are OpenAI models on api.openai.com', () => {
  const expected = {
    'gpt-image-2.6-sunburst-openai': 'gpt-image-2.6-sunburst',
    'gpt-image-2.6-flare-openai': 'gpt-image-2.6-flare',
    'gpt-image-flare-openai': 'gpt-image-2.5-flare-2026-09-08',
    'gpt-image-sunburst-openai': 'gpt-image-2.5-sunburst-2026-09-08',
    'analyser-luna-openai': 'gpt-5.6-luna',
  };
  for (const [id, modelId] of Object.entries(expected)) {
    const entry = modelById(id);
    assert.equal(entry.provider, 'openai', id);
    assert.equal(entry.bedrockModelId, modelId, id);
    assert.equal(entry.region, 'api.openai.com', id);
    assert.deepEqual(entry.residency, ['api.openai.com'], id);
    assert.equal(entry.isDefault, id === 'gpt-image-2.6-sunburst-openai', id);
  }
  // Same params as the gateway image entries, so a run looks the same whichever way it went.
  assert.deepEqual(modelById('gpt-image-flare-openai').params, modelById('gpt-image-flare').params);
  assert.deepEqual(modelById('analyser-luna-openai').params, []);
});

test('an openai entry must name an OpenAI API host as its region and its whole residency', () => {
  const openai = {
    ...validEntry,
    provider: 'openai',
    bedrockModelId: 'gpt-image-2.5-flare-2026-09-08',
    region: 'api.openai.com',
    residency: ['api.openai.com'],
  };
  assert.equal(modelEntrySchema.safeParse(openai).success, true);
  assert.equal(
    modelEntrySchema.safeParse({
      ...openai,
      region: 'eu.api.openai.com',
      residency: ['eu.api.openai.com'],
    }).success,
    true,
  );

  for (const [bad, message] of [
    [{ ...openai, region: 'us-east-1', residency: ['us-east-1'] }, /region is its API host/],
    [
      { ...openai, region: 'api.openai.com.evil.test', residency: ['api.openai.com.evil.test'] },
      /region is its API host/,
    ],
    [
      { ...openai, residency: ['api.openai.com', 'us-east-1'] },
      /residency is exactly its API host/,
    ],
    [{ ...openai, residency: ['api.openai.com', 'global'] }, /residency/],
  ] as const) {
    const result = modelEntrySchema.safeParse(bad);
    assert.equal(result.success, false, JSON.stringify(bad.residency));
    assert.ok(
      result.error!.issues.some((i) => message.test(i.message)),
      result.error!.issues.map((i) => i.message).join('; '),
    );
  }
});

const GPT_IMAGE_IDS = [
  'gpt-image-flare',
  'gpt-image-flare-openai',
  'gpt-image-sunburst',
  'gpt-image-sunburst-openai',
];

test('the GPT image entries default to the validated view size and quality and offer the fallbacks', () => {
  for (const id of GPT_IMAGE_IDS) {
    const entry = modelById(id);
    const size = entry.params.find((p) => p.key === 'size');
    const quality = entry.params.find((p) => p.key === 'quality');
    assert.equal(size?.default, '2336x3504', id);
    assert.ok(
      size?.options?.some((o) => o.value === '1536x2304'),
      `${id}: no 2:3 fallback size`,
    );
    assert.equal(quality?.default, 'max', id);
    assert.deepEqual(
      quality?.options?.map((o) => o.value),
      ['low', 'medium', 'high', 'xhigh', 'max'],
      id,
    );
    // Not published for `max`: a number here would be a guess the UI then shows as a fact.
    assert.equal(entry.costPerCall, undefined, id);
  }
});

test('selectParam takes the registry default, an offered override, and refuses the rest', () => {
  const entry = modelById('gpt-image-flare');
  assert.equal(selectParam(entry, 'quality'), 'max');
  assert.equal(selectParam(entry, 'quality', 'high'), 'high');
  assert.equal(selectParam(entry, 'quality', '  '), 'max');
  assert.equal(selectParam(entry, 'no_such_param'), undefined);
  assert.throws(
    () => selectParam(entry, 'quality', 'best'),
    /does not offer quality "best"; options: low/,
  );
  assert.throws(
    () => selectParam(entry, 'no_such_param', 'x'),
    /does not offer no_such_param "x"$/,
  );
});

/**
 * The deployment may pin the size and the quality next to the model; a value the entry does not
 * offer would fail every generation of that deployment.
 */
test('image_size and image_quality in Terraform are options of the image model they go with', () => {
  const tf = readFileSync(join(envDir, 'variables.tf'), 'utf8');
  for (const name of ['image_size', 'image_quality']) {
    const block = new RegExp(`variable "${name}"[\\s\\S]*?\\n}`).exec(tf);
    assert.ok(block, `infra/envs/dev/variables.tf declares no variable "${name}"`);
    assert.match(block[0], /default\s*=\s*""/, `${name} defaults to the registry value`);
  }
  for (const file of readdirSync(envDir).filter((f) => f.endsWith('.tfvars'))) {
    const tfvars = readFileSync(join(envDir, file), 'utf8');
    const read = (name: string) => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(tfvars)?.[1];
    const entry = deployedModel('image-control', read('image_model'));
    for (const [name, key] of [
      ['image_size', 'size'],
      ['image_quality', 'quality'],
    ] as const) {
      const value = read(name);
      if (value) assert.doesNotThrow(() => selectParam(entry, key, value), `${file}: ${name}`);
    }
  }
});
