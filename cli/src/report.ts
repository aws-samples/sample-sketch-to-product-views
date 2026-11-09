import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { IMAGE_KIND_LABELS, type Candidate, type PipelineState } from '@sketch-to-product-views/contracts';

/**
 * One static page per run: the inputs, then every attempt's views with the critic's verdict,
 * scores, issues and the prompt that made them, then the event log. Rewritten as the run goes.
 */

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const VIEWS = ['front', 'back', 'left', 'right'] as const;

export function writeReport(
  state: PipelineState,
  runDir: string,
  pathOf: (key: string) => string,
): void {
  const src = (key?: string) => (key ? esc(relative(runDir, pathOf(key))) : '');

  // Labelled with what the analyser read each image as, once it has.
  const kind = (n: number) => {
    const read = state.analysis?.images?.[n]?.kind;
    return read ? `${IMAGE_KIND_LABELS[read]}: ` : '';
  };
  const inputs = state.inputs
    .map(
      (i, n) =>
        `<figure><img src="${src(i.key)}"><figcaption>${esc(kind(n) + i.filename)}</figcaption></figure>`,
    )
    .join('');

  const byAttempt = new Map<number, Candidate[]>();
  for (const c of state.candidates) byAttempt.set(c.attempt, [...(byAttempt.get(c.attempt) ?? []), c]);

  const card = (c: Candidate) => {
    const e = c.evaluation;
    const scores = e
      ? `fidelity ${e.scores.sketchFidelity.toFixed(2)} · spec ${e.scores.specAdherence.toFixed(2)} · quality ${e.scores.imageQuality.toFixed(2)}`
      : 'not scored';
    return `<figure class="${esc(e?.verdict ?? 'none')}">
      <img src="${src(c.key)}" loading="lazy">
      <figcaption><b>${esc(c.view ?? 'front')}</b> <span class="verdict">${esc(e?.verdict ?? '—')}</span><br>${scores}
      ${e?.issues.length ? `<ul>${e.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${c.prompt ? `<details><summary>prompt</summary><pre>${esc(c.prompt)}</pre></details>` : ''}</figcaption>
    </figure>`;
  };

  const attempts = [...byAttempt.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, views]) => {
      const sorted = [...views].sort(
        (a, b) => VIEWS.indexOf(a.view ?? 'front') - VIEWS.indexOf(b.view ?? 'front'),
      );
      return `<h2>Attempt ${n}</h2><div class="row">${sorted.map(card).join('')}</div>`;
    })
    .join('');

  const events = state.events
    .map((e) => `<tr><td>${esc(e.at.slice(11, 19))}</td><td>${esc(e.stage)}</td><td>${esc(e.status)}</td><td>${esc(e.view)}</td><td>${esc(e.message)}</td></tr>`)
    .join('');

  writeFileSync(
    join(runDir, 'report.html'),
    `<!doctype html><meta charset="utf-8"><title>${esc(state.productId)} · 2D run</title>
<meta http-equiv="refresh" content="${state.status === 'running' ? 10 : 86400}">
<style>
body{font:14px system-ui;margin:24px;color:#222}.row{display:flex;gap:12px;flex-wrap:wrap}
figure{margin:0;width:260px}img{width:100%;background:#eee;border:1px solid #ddd}
.pass .verdict{color:#16794a}.warn .verdict{color:#b26b00}.fail .verdict{color:#c0262d}
pre{white-space:pre-wrap;font-size:11px;max-height:300px;overflow:auto;background:#f6f6f6}
td{padding:2px 8px;vertical-align:top;border-bottom:1px solid #eee}ul{padding-left:16px;margin:4px 0}
</style>
<h1>${esc(state.productId)} <small>${esc(state.status)}${state.failureReason ? ` — ${esc(state.failureReason)}` : ''}</small></h1>
<p>Image model <code>${esc(state.modelId)}</code> · revision <code>${esc(state.revisionId)}</code></p>
<div class="row">${inputs}</div>
${state.warning ? `<p><b>Warning:</b> ${esc(state.warning)}</p>` : ''}
${state.spec ? `<details><summary>Specification</summary><pre>${esc(JSON.stringify(state.spec, null, 2))}</pre></details>` : ''}
${attempts}
<h2>Events</h2><table>${events}</table>`,
  );
}
