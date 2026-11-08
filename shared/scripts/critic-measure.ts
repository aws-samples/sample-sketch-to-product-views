/**
 * Replays the critic on stored generated views a person labelled good or bad, and reports how
 * often it agrees. Reads the deployed table and bucket; calls the critic model only with --yes.
 *
 *   TABLE_NAME=… ARTIFACTS_BUCKET=… AWS_REGION=… [EVALUATION_MODEL=critic-sonnet] \
 *     npm run critic:measure -w @sketch-to-product-views/shared -- labels.csv [--out results.csv] [--yes]
 *
 * Labels: JSON (an array of rows) or CSV with a header, columns
 * `revisionId,view,attempt,label,note` (`view` front|back|left|right, `label` good|bad).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  CANDIDATE_VIEWS,
  changedAttributes,
  planImages,
  requestsByView,
  type Evaluation,
  type PipelineState,
} from '@sketch-to-product-views/contracts';
import { resolveModel } from '../src/registry/index.js';
import { getArtifact, getRevision, sniffImageType } from '../src/store/index.js';
import {
  createConverseRunner,
  createJudgeCritic,
  type CriticRunner,
} from '../src/qc/judge/index.js';

const labelSchema = z.object({
  revisionId: z.string().min(1),
  view: z.enum(CANDIDATE_VIEWS).default('front'),
  attempt: z.coerce.number().int().positive(),
  label: z.enum(['good', 'bad']),
  note: z.string().optional(),
});
type Label = z.infer<typeof labelSchema>;

/** Comma separated, double quotes around a cell holding a comma or a quote ("" escapes one). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') ((cell += '"'), i++);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      (row.push(cell), rows.push(row), (row = []), (cell = ''));
    } else cell += ch;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  const [header = [], ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  return body.map((cells) =>
    Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim()])),
  );
}

export function readLabels(path: string): Label[] {
  const text = readFileSync(path, 'utf8');
  const raw: unknown[] = path.endsWith('.json') ? JSON.parse(text) : parseCsv(text);
  return raw.map((row, i) => {
    const cleaned = Object.fromEntries(
      Object.entries(row as Record<string, unknown>).filter(([, v]) => v !== ''),
    );
    const parsed = labelSchema.safeParse(cleaned);
    if (!parsed.success) throw new Error(`label ${i + 1}: ${parsed.error.issues[0].message}`);
    return parsed.data;
  });
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

interface Row {
  label: Label;
  stored?: Evaluation['verdict'];
  result?: Evaluation;
  error?: string;
}

const isFail = (v?: string) => v === 'fail';

function report(rows: Row[], calls: number) {
  const scored = rows.filter((r) => r.result);
  const good = scored.filter((r) => r.label.label === 'good');
  const bad = scored.filter((r) => r.label.label === 'bad');
  const rate = (n: number, of: number) =>
    of === 0 ? '-' : `${n}/${of} (${Math.round((n / of) * 100)}%)`;

  const table = (name: string, verdictOf: (r: Row) => string | undefined) => {
    const count = (set: Row[], v: string) => set.filter((r) => verdictOf(r) === v).length;
    console.log(`\n${name}`);
    console.log('            pass  warn  fail');
    for (const [label, set] of [
      ['human good', good],
      ['human bad ', bad],
    ] as const) {
      console.log(
        `${label}  ${['pass', 'warn', 'fail'].map((v) => String(count(set, v)).padStart(4)).join('  ')}`,
      );
    }
    const falseFail = good.filter((r) => isFail(verdictOf(r))).length;
    const falsePass = bad.filter((r) => verdictOf(r) && !isFail(verdictOf(r))).length;
    console.log(`false fail (good view failed):     ${rate(falseFail, good.length)}`);
    console.log(`false pass (bad view not failed):  ${rate(falsePass, bad.length)}`);
  };

  table('Critic now', (r) => r.result?.verdict);
  const withStored = scored.filter((r) => r.stored);
  if (withStored.length > 0) table('Stored verdict (the critic of the run)', (r) => r.stored);

  // Per aspect: answered different on a good view (likely noise) and on a bad one.
  const byAspect = new Map<string, { good: number; bad: number }>();
  for (const r of scored) {
    for (const a of r.result!.attributes ?? []) {
      if (a.outcome !== 'mismatch') continue;
      const name = a.attribute.startsWith('part: ') ? 'parts' : a.attribute;
      const entry = byAspect.get(name) ?? { good: 0, bad: 0 };
      entry[r.label.label] += 1;
      byAspect.set(name, entry);
    }
  }
  console.log('\nAnswered different, per aspect   on good  on bad');
  for (const [name, { good: g, bad: b }] of [...byAspect].sort()) {
    console.log(`${name.padEnd(32)} ${String(g).padStart(7)}  ${String(b).padStart(6)}`);
  }
  const confirmations = scored.filter((r) => r.result!.confirmation);
  const overturned = confirmations.filter((r) => r.result!.confirmation!.confirmed.length === 0);
  console.log(
    `\nConfirmation calls: ${confirmations.length}, overturned a fail: ${overturned.length}`,
  );
  const errors = rows.filter((r) => r.error);
  if (errors.length > 0) console.log(`Not scored: ${errors.length} (see the CSV)`);
  console.log(`Model calls made: ${calls}`);
}

function writeCsv(path: string, rows: Row[]) {
  const header = [
    'revisionId',
    'view',
    'attempt',
    'label',
    'note',
    'stored_verdict',
    'verdict',
    'failed_on',
    'confirmed',
    'different',
    'issues',
    'sketch_fidelity',
    'spec_adherence',
    'image_quality',
    'error',
  ];
  const lines = rows.map((r) => {
    const e = r.result;
    return [
      r.label.revisionId,
      r.label.view,
      r.label.attempt,
      r.label.label,
      r.label.note,
      r.stored,
      e?.verdict,
      e?.confirmation?.failedOn.join(' '),
      e?.confirmation?.confirmed.join(' '),
      e?.attributes
        ?.filter((a) => a.outcome === 'mismatch')
        .map((a) => a.attribute)
        .join('; '),
      e?.issues.join(' | '),
      e?.scores.sketchFidelity,
      e?.scores.specAdherence,
      e?.scores.imageQuality,
      r.error,
    ]
      .map(csvCell)
      .join(',');
  });
  writeFileSync(path, [header.join(','), ...lines].join('\n') + '\n');
}

async function main(argv: string[]) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flag = (name: string) => argv.includes(`--${name}`);
  const option = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = args.find((a) => a !== option('out'));
  if (!file) {
    console.error('usage: critic:measure <labels.csv|labels.json> [--out results.csv] [--yes]');
    process.exit(2);
  }

  const labels = readLabels(file);
  const entry = resolveModel('critic', process.env.EVALUATION_MODEL || undefined);
  const out = option('out') ?? `critic-measure-${basename(file).replace(/\.\w+$/, '')}.csv`;
  console.log(
    `${labels.length} labelled views. The critic (${entry.id}, ${entry.bedrockModelId}) makes one comparison call per view, a second for a view it would fail, and one request check per view that had design notes: between ${labels.length} and ${labels.length * 3} calls, each up to 3 turns on a schema correction.`,
  );
  if (!flag('yes')) {
    console.log('Dry run: nothing was read or called. Add --yes to run.');
    return;
  }
  for (const name of ['TABLE_NAME', 'ARTIFACTS_BUCKET', 'AWS_REGION']) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }

  let calls = 0;
  const real = createConverseRunner();
  const counted: CriticRunner = (request) => {
    calls += 1;
    return real(request);
  };
  const critic = createJudgeCritic({ runner: counted });
  const runs = new Map<string, Promise<PipelineState | undefined>>();
  const rows: Row[] = [];

  // One view at a time: a measurement is not worth a throttled account.
  for (const label of labels) {
    const row: Row = { label };
    rows.push(row);
    try {
      if (!runs.has(label.revisionId)) runs.set(label.revisionId, getRevision(label.revisionId));
      const state = await runs.get(label.revisionId);
      if (!state) throw new Error('no such revision');
      if (!state.spec) throw new Error('the revision has no spec');
      const candidate = state.candidates.find(
        (c) => c.attempt === label.attempt && (c.view ?? 'front') === label.view,
      );
      if (!candidate?.key) throw new Error('no stored candidate for that view and attempt');
      // The images as the run's analyser decided, as the pipeline's critic picks them.
      const plan = planImages(state.inputs, state.spec.imageKinds);
      const sketchKey = plan.criticReference?.file.key;
      if (!sketchKey) throw new Error('the revision has no stored sketch or photo');
      const swatchKey = plan.material?.key;
      row.stored = candidate.evaluation?.verdict;

      const [sketch, image, swatch] = await Promise.all([
        getArtifact(sketchKey),
        getArtifact(candidate.key),
        swatchKey ? getArtifact(swatchKey) : undefined,
      ]);
      const guidance = state.guidance ? [state.guidance] : [];
      const requests = requestsByView(guidance)[label.view];
      const changed = changedAttributes(guidance);
      row.result = await critic.evaluate({
        sketch,
        sketchContentType: sniffImageType(sketch) ?? 'image/png',
        ...(plan.criticReference?.kind === 'photo' ? { sketchKind: 'photo' as const } : {}),
        candidate: image,
        candidateContentType: sniffImageType(image) ?? 'image/png',
        ...(swatch && { swatch, swatchContentType: sniffImageType(swatch) ?? 'image/png' }),
        spec: state.spec,
        modelId: entry.id,
        view: label.view,
        ...(requests?.length ? { requests } : {}),
        ...(changed.length ? { changed } : {}),
      });
      console.log(
        `${label.revisionId} ${label.view} #${label.attempt}: human ${label.label}, critic ${row.result.verdict}`,
      );
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      console.log(`${label.revisionId} ${label.view} #${label.attempt}: ${row.error}`);
    }
  }

  report(rows, calls);
  writeCsv(out, rows);
  console.log(`\nWrote ${out}`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
