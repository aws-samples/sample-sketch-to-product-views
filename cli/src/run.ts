import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * `npm run 2d -- --image sketch.png`: the deployed pipeline's handler, in-process.
 *
 * Same stages, prompts, critic, retry loop and review gate as the Lambda durable function.
 * `./local/context.ts` stands in for the durable runtime, `./local/store.ts` for DynamoDB and
 * S3. Models: OpenAI for images (`OPENAI_API_KEY`), Bedrock for the analyser and the critic
 * (your AWS credentials, us-east-1 by default).
 */

const LOCAL_STORE = new URL('./local/store.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@sketch-to-product-views/shared/store' && context.parentURL?.includes('/pipeline/src/')) {
      return { url: LOCAL_STORE, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { values } = parseArgs({
  options: {
    image: { type: 'string', multiple: true },
    // Aliases of --image, kept for older scripts: the analyser decides what each image is.
    sketch: { type: 'string', multiple: true },
    'material-sample': { type: 'string', multiple: true },
    swatch: { type: 'string', multiple: true },
    metadata: { type: 'string' },
    notes: { type: 'string' },
    'auto-approve': { type: 'boolean', default: false },
    'fake-images': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const USAGE = `Usage:
  npm run 2d -- --image a.jpg --image m.jpg [--metadata details.txt]
Options:
  --image FILE       an image of the product or its material, repeatable, 1 to 5; the analyser
                     decides what each one is (--sketch, --material-sample, --swatch: aliases)
  --metadata FILE    product details, plain text or JSON (.txt or .json)
  --notes TEXT       design-team guidance for the first generation
  --auto-approve     approve at the review gate instead of asking
  --fake-images      answer image calls locally with the sketch itself: a free smoke test of
                     the analyser, critic and retry loop (the critic should reject every view)
Env: OPENAI_API_KEY (required), AWS credentials for Bedrock, IMAGE_MODEL, IMAGE_SIZE,
     IMAGE_QUALITY, ATTEMPT_BUDGET, ANALYSER_MODEL, EVALUATION_MODEL, AWS_REGION,
     GUARDRAIL_ID and GUARDRAIL_VERSION (optional: a Bedrock guardrail in AWS_REGION)`;

// Every image flag adds images, in the order given; none of them tags a role.
const imageFlags = [
  ...(values.image ?? []),
  ...(values.sketch ?? []),
  ...(values['material-sample'] ?? []),
  ...(values.swatch ?? []),
];

if (values.help || imageFlags.length === 0) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

process.env.LOCAL_PIPELINE = '1';
process.env.ANALYSER_MODEL ||= 'analyser-sonnet-bedrock';
process.env.EVALUATION_MODEL ||= 'critic-sonnet';
process.env.IMAGE_MODEL ||= 'gpt-image-2.6-sunburst-openai';
process.env.AWS_REGION ||= 'us-east-1';
process.env.IMAGE_CALL_TIMEOUT_MS ||= '900000';
if (values['fake-images']) {
  const { startFakeImages } = await import('./fake-images.js');
  process.env.OPENAI_BASE_URL = await startFakeImages();
  process.env.OPENAI_API_KEY ||= 'fake';
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set: put it in .env.local or export it.');
  process.exit(1);
}

// npm runs a workspace script in the workspace: resolve paths against where it was called from.
const callerDir = process.env.INIT_CWD ?? process.cwd();
const fromCaller = (path: string) => resolve(callerDir, path);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The product to run, with its images as paths, in submission order. */
function resolveProduct(): { id: string; files: string[]; metadata?: unknown } {
  const files = imageFlags.map(fromCaller);
  return {
    id: basename(files[0]).replace(/\.[^.]+$/, ''),
    files,
    ...(values.metadata ? { metadata: readFileSync(fromCaller(values.metadata), 'utf8') } : {}),
  };
}

const product = resolveProduct();
for (const f of product.files) {
  if (!existsSync(f)) throw new Error(`missing input ${f}`);
}

// Every input is read through an `inputs/` key, relative to the filesystem root.
process.env.LOCAL_INPUTS_DIR = '/';
const inputKey = (path: string) => `inputs/${relative('/', path)}`;

// One folder per run: its images, state.json and report.html. Set before the store is loaded.
const now = new Date().toISOString();
const runDir = join(
  process.env.RUNS_DIR ? fromCaller(process.env.RUNS_DIR) : join(REPO_ROOT, 'runs'),
  `${now.replace(/[:.]/g, '-')}-${product.id}`,
);
mkdirSync(runDir, { recursive: true });
process.env.LOCAL_ARTIFACTS_DIR = runDir;

const contracts = await import('@sketch-to-product-views/contracts');
const { GUARDRAIL_OFF_WARNING, guardrailFromEnv } = await import('@sketch-to-product-views/shared/guardrail');
const guardrail = guardrailFromEnv();
console.log(
  guardrail
    ? `[2d] guardrail ${guardrail.id} version ${guardrail.version}`
    : `[2d] ${GUARDRAIL_OFF_WARNING}`,
);
const notes = values.notes ? contracts.sanitizeText(values.notes, { multiline: true }) : '';
const productId = contracts.sanitizeText(product.id);
const { put, get, emit, initialStages } = await import('./local/revisions.js');
const store = await import('./local/store.js');
const { localContext } = await import('./local/context.js');
const { runDurable } = await import('../../pipeline/src/handler.js');
const { writeReport } = await import('./report.js');

let productMetadata;
if (product.metadata !== undefined) {
  // A file's text as it is; a dataset row's JSON as the business exported it.
  const text =
    typeof product.metadata === 'string' ? product.metadata : JSON.stringify(product.metadata);
  const checked = contracts.validateProductMetadataText(text);
  if (!checked.ok) throw new Error(`productMetadata: ${checked.error.message}`);
  productMetadata = checked.metadata;
}

const inputs = product.files.map((f) => ({
  filename: contracts.sanitizeText(basename(f)),
  url: f,
  key: inputKey(f),
}));
const { errors } = contracts.validatePackage(inputs);
if (errors.length > 0) throw new Error(`inputs: ${errors.join(' ')}`);

const revisionId = randomUUID();
put({
  revisionId,
  productId,
  revision: 1,
  status: 'running',
  createdAt: now,
  updatedAt: now,
  owner: 'cli',
  modelId: process.env.IMAGE_MODEL,
  attemptBudget: Number(process.env.ATTEMPT_BUDGET ?? 2),
  attempt: 0,
  inputs,
  ...(productMetadata ? { productMetadata } : {}),
  stages: initialStages(),
  candidates: [],
  events: [],
});
emit(revisionId, 'upload', 'passed', { message: `${inputs.length} file(s) received.` });
emit(revisionId, 'submit', 'passed', { message: 'Revision 1 manifest recorded.' });

const snapshot = () => {
  const state = get(revisionId)!;
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  writeReport(state, runDir, store.artifactPath);
  return state;
};

console.log(
  `[2d] ${productId}: revision ${revisionId.slice(0, 8)}, report at ${runDir}/report.html`,
);
const local = localContext(revisionId);
const run = runDurable(
  {
    revisionId,
    productId,
    inputs,
    ...(productMetadata ? { productMetadata } : {}),
    modelId: process.env.IMAGE_MODEL,
    createdAt: now,
    ...(notes ? { requests: { notes } } : {}),
  },
  local.ctx,
);

// The review gate: the handler waits on a callback, as it does in the deployed pipeline.
let finished = false;
run.finally(() => (finished = true)).catch(() => {});
const ask = createInterface({ input: process.stdin, output: process.stdout });
while (!finished) {
  await new Promise((r) => setTimeout(r, 1000));
  const state = snapshot();
  const callbackId = await store.getReviewCallbackId(revisionId);
  if (state.status !== 'awaiting_review' || !callbackId) continue;

  let decision: { decision: 'approve' | 'regenerate'; notes?: string } = { decision: 'approve' };
  if (!values['auto-approve']) {
    console.log(`\n[2d] review the views in ${join(runDir, 'report.html')}`);
    const typed = await ask.question('Approve? Press Enter, or type what to change: ');
    const change = contracts.sanitizeText(typed, { multiline: true });
    if (change) decision = { decision: 'regenerate', notes: change };
  }
  await store.setReviewCallbackId(revisionId, '');
  local.complete(
    callbackId,
    JSON.stringify({ ...decision, reviewedBy: 'cli', reviewedAt: new Date().toISOString() }),
  );
}
ask.close();

const result = (await run) as { status: string; reason?: string };
const state = snapshot();
console.log(`[2d] ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
console.log(`[2d] ${state.candidates.length} image(s); report: ${join(runDir, 'report.html')}`);
process.exit(result.status === 'approved' ? 0 : 1);
