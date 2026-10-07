#!/usr/bin/env node
// Sends a test transcript to the Anthropic API exactly the way the app's
// requestExtraction() does (same model, system prompt, max_tokens and
// effort), and saves the answer for score.mjs. Only works where an
// ANTHROPIC_API_KEY is set; without one, use eval-workflow.js instead.
//   ANTHROPIC_API_KEY=... node tests/extraction/run-api.mjs house-test-2 [runs] [tag]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

// Keep in step with requestExtraction() in js/app.js.
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 16000;
const EFFORT = 'medium';

// The text of a `const NAME = \`...\`` template literal in a source file.
function readTemplate(file, name) {
  const src = readFileSync(join(repo, file), 'utf8');
  const start = src.indexOf(`const ${name} = \``);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  let i = start + `const ${name} = \``.length, out = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { out += src[++i]; continue; }
    if (ch === '`') return out;
    if (ch === '$' && src[i + 1] === '{') throw new Error(`${name} uses \${...}; this script can't evaluate it`);
    out += ch;
  }
  throw new Error(`${name} has no closing backtick`);
}

const [id, runsArg, tagArg] = process.argv.slice(2);
if (!id) { console.error('usage: node run-api.mjs <case-id> [runs] [tag]'); process.exit(2); }
const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(2); }
const runs = Number(runsArg) || 1;
const tag = tagArg || 'api';
const system = readTemplate('js/app.js', 'SYSTEM_PROMPT');
const transcript = readFileSync(join(here, 'transcripts', `${id}.txt`), 'utf8').trim();
const outDir = join(here, 'out', tag);
mkdirSync(outDir, { recursive: true });
const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

for (let k = 1; k <= runs; k++) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, output_config: { effort: EFFORT }, system, messages: [{ role: 'user', content: transcript }] }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(`run ${k}: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`); process.exit(1); }
  const text = (data.content || []).map(b => b.text || '').join('');
  const file = join(outDir, `${id}-run${k}.json`);
  writeFileSync(file, text);
  console.log(`run ${k}: ${data.stop_reason}, ${data.usage?.input_tokens} in / ${data.usage?.output_tokens} out -> ${file}`);
}
