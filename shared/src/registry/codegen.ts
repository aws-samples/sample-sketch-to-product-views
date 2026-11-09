/**
 * Compiles `models/*.yaml` into `generated/models.json`.
 *
 * The YAML is the authored form; the JSON is what ships. Validating at build time
 * rather than at cold start means a malformed or legacy model breaks CI instead of
 * failing a revision halfway through a run — and it keeps a YAML parser out of the
 * Lambda bundle entirely.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { registrySchema } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(here, 'models');
const outDir = join(here, 'generated');
const outFile = join(outDir, 'models.json');

const files = readdirSync(modelsDir)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

if (files.length === 0) {
  throw new Error(`no model YAML found in ${modelsDir}`);
}

const raw = files.map((file) => {
  try {
    return parse(readFileSync(join(modelsDir, file), 'utf8'));
  } catch (cause) {
    throw new Error(`${file}: not valid YAML`, { cause });
  }
});

const parsed = registrySchema.safeParse(raw);

if (!parsed.success) {
  // Name the file, not just the array index — an index is useless when the fix is in
  // one of a dozen YAML files.
  const lines = parsed.error.issues.map((issue) => {
    const [index, ...rest] = issue.path;
    const file = typeof index === 'number' ? files[index] : '(registry)';
    const field = rest.join('.');
    return `  ${file}${field ? ` → ${field}` : ''}: ${issue.message}`;
  });
  throw new Error(`model registry is invalid:\n${lines.join('\n')}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(parsed.data, null, 2)}\n`);

console.log(`registry: ${parsed.data.length} models -> ${outFile}`);
