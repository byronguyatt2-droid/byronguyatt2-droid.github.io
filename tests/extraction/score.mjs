#!/usr/bin/env node
// Scores extraction outputs (the JSON the AI returns for a transcript)
// against an answer key in gold/. Usage:
//   node tests/extraction/score.mjs gold/house-test-2.json out1.json [out2.json ...]
// Prints each run's failures and score, then the pass rate of every check
// across all runs, so a check that only passes sometimes stands out.
import { readFileSync } from 'node:fs';

const norm = v => (v === null || v === undefined) ? null : String(v).toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const isEmpty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const allStrings = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => allStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => allStrings(x, out));
  return out;
};
const textOf = v => allStrings(v).join(' | ').toLowerCase();

// One check against one object (the whole output, or one finding).
function runCheck(c, obj) {
  const v = c.path ? get(obj, c.path) : obj;
  switch (c.kind) {
    case 'equals': {
      const ok = c.values.some(x => (x === null ? isEmpty(v) : norm(v) === norm(x)));
      return { ok, got: v };
    }
    case 'mentions': {
      if (isEmpty(v)) return { ok: !!c.nullOk, got: v };
      const t = textOf(v);
      const missing = (c.all || []).filter(group => !group.some(alt => t.includes(alt.toLowerCase())));
      const banned = (c.none || []).filter(term => t.includes(term.toLowerCase()));
      return { ok: !missing.length && !banned.length, got: v,
        why: [missing.length && `missing ${missing.map(g => g.join('/')).join(', ')}`, banned.length && `contains ${banned.join(', ')}`].filter(Boolean).join('; ') };
    }
    case 'absent':
      return { ok: isEmpty(v), got: v };
    case 'count': {
      const n = Array.isArray(v) ? v.length : 0;
      return { ok: n >= (c.min ?? 0) && n <= (c.max ?? Infinity), got: n };
    }
    case 'forbidAnywhere': {
      const t = textOf(obj);
      const hits = c.terms.filter(term => t.includes(term.toLowerCase()));
      return { ok: !hits.length, got: hits.join(', ') || 'none' };
    }
    case 'every': {
      // Every element of the array at `path` must pass all sub-checks
      // (a sub-check with no path looks at the whole element). An empty or
      // missing array passes, so pair this with a `count` check.
      const bad = [];
      (Array.isArray(v) ? v : []).forEach((el, i) => {
        const fails = c.checks.map(s => ({ s, r: runCheck(s, el) })).filter(x => !x.r.ok);
        if (fails.length) bad.push(`[${i}] ` + fails.map(x => `${x.s.path || '(any field)'}: ${x.r.why || JSON.stringify(x.r.got)}`).join('; '));
      });
      return { ok: !bad.length, got: v, why: bad.join(' | ') };
    }
    default:
      throw new Error(`unknown check kind ${c.kind} (${c.id})`);
  }
}

// Every findingMatch check needs its own finding: a finding used by one
// check can't satisfy another.
function scoreRun(gold, out) {
  const results = [];
  const used = new Set();
  const findings = Array.isArray(out.findings) ? out.findings : [];
  for (const c of gold.checks) {
    if (c.kind === 'manual') continue;
    if (c.kind === 'findingMatch') {
      let hit = -1, best = null;
      findings.forEach((f, i) => {
        if (hit >= 0 || used.has(i)) return;
        const sub = c.checks.map(s => ({ s, r: runCheck(s, f) }));
        if (sub.every(x => x.r.ok)) hit = i;
        else if (!best || sub.filter(x => x.r.ok).length > best.filter(x => x.r.ok).length) best = sub;
      });
      if (hit >= 0) used.add(hit);
      const why = hit >= 0 ? '' : best ? best.filter(x => !x.r.ok).map(x => `${x.s.path}: ${x.r.why || JSON.stringify(x.r.got)}`).join('; ') : 'no findings';
      results.push({ c, ok: hit >= 0, why });
    } else {
      const r = runCheck(c, out);
      results.push({ c, ok: r.ok, why: r.ok ? '' : (r.why || `got ${JSON.stringify(r.got)}`) });
    }
  }
  return results;
}

const [goldPath, ...outPaths] = process.argv.slice(2);
if (!goldPath || !outPaths.length) {
  console.error('usage: node score.mjs <gold.json> <output.json> [more outputs...]');
  process.exit(2);
}
const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
const parseOut = p => {
  const raw = readFileSync(p, 'utf8');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
};

const tally = new Map();
for (const p of outPaths) {
  let out;
  try { out = parseOut(p); } catch (e) {
    // The app can't use an answer it can't parse, so every check fails this run.
    console.log(`\n${p}: NOT VALID JSON (${e.message}), counted as failing every check`);
    for (const c of gold.checks) if (c.kind !== 'manual') {
      const t = tally.get(c.id) || { pass: 0, runs: 0 };
      t.runs++; tally.set(c.id, t);
    }
    continue;
  }
  const results = scoreRun(gold, out);
  const total = results.reduce((s, r) => s + (r.c.weight ?? 1), 0);
  const got = results.reduce((s, r) => s + (r.ok ? (r.c.weight ?? 1) : 0), 0);
  const critical = results.filter(r => !r.ok && (r.c.weight ?? 1) >= 3);
  console.log(`\n${p}: ${got}/${total} (${Math.round(100 * got / total)}%)${critical.length ? `, ${critical.length} critical failure(s)` : ''}`);
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  ${(r.c.weight ?? 1) >= 3 ? 'CRITICAL' : 'fail    '} ${r.c.id}: ${r.why}`);
  }
  for (const r of results) {
    const t = tally.get(r.c.id) || { pass: 0, runs: 0 };
    t.runs++; if (r.ok) t.pass++;
    tally.set(r.c.id, t);
  }
}
if (outPaths.length > 1) {
  console.log('\nPass rate per check (only checks that failed at least once):');
  for (const [id, t] of tally) if (t.pass < t.runs) console.log(`  ${id}: ${t.pass}/${t.runs}`);
}
const manual = gold.checks.filter(c => c.kind === 'manual');
if (manual.length) {
  console.log('\nJudge these by reading the output (not scored):');
  manual.forEach(c => console.log(`  ${c.id}: ${c.description}`));
}
