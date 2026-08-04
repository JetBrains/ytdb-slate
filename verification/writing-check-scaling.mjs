#!/usr/bin/env node
// =============================================================================
// slate — writing-checker scaling gate
// =============================================================================
// Why this file exists, and why it is not part of writing-check-tests.mjs.
//
// Three independent reviews of the shipped checker found SIX separate
// superlinear paths in one module (SC1 x4, SC2, BG1/PF1). Every one of them was
// a correct-but-quadratic scan: the findings were right, so the correctness
// suite stayed green while a legal 1 MiB message took 50-186 SECONDS inside a
// synchronous turn hook. Spot-fixing six patterns leaves the class open — the
// module holds ~30 more regexes that nobody had shown to be linear, and the next
// one added would reintroduce it.
//
// So this gate is about GROWTH, not about findings:
//
//   * ROSTER. Every regex literal in the module is extracted from its SOURCE and
//     must be named in COVERAGE below, either with a hostile generator or with a
//     written reason it cannot scale. A new regex fails this gate until someone
//     decides which it is. That is the part that makes the net permanent; without
//     it the table rots on the first commit after this one.
//
//   * BUDGET (the gate that actually protects the hook). Every pattern and every
//     pass runs its hostile input at the module's own MAX_INPUT_BYTES and must
//     finish inside BUDGET_MS. This is the property that matters — "no legal
//     input stalls a turn" — and it is stated as an absolute, not a ratio,
//     because the margin is enormous: the linear forms measure single-digit to
//     ~250 ms where the quadratic ones measured 50,000-186,000 ms. Two to three
//     orders of magnitude of headroom is what makes a wall-clock assertion safe
//     to gate on.
//
//   * GROWTH. Timings at four doubling sizes; a doubling must not quadruple the
//     cost. Reported for every subject and ENFORCED wherever the signal clears
//     NOISE_FLOOR_MS, which keeps the gate off measurements that are pure timer
//     jitter. Below the floor the budget check above still binds, so nothing is
//     left unguarded — the line says which rule decided.
//
//   * CANARY. A deliberately quadratic pattern is measured alongside the real
//     ones and the gate must judge it superlinear AND over budget. A timing gate
//     that has silently stopped discriminating — a machine too fast, a threshold
//     edited, an engine optimisation — is otherwise indistinguishable from a
//     clean run. If the canary passes, this whole file failed.
//
// Timing gates are flaky when they are tight. This one is deliberately loose:
// min-of-REPEATS (minimum, not mean — scheduler noise is one-sided, so the
// minimum is the stable estimator), a growth threshold at 3x the ideal, and a
// budget with ~4x headroom over the slowest honest subject. Determinism comes
// from fixed generators; nothing here is random.
//
// Run:  node verification/writing-check-scaling.mjs [--quick]
// Exit: 0 all checks passed · 1 a check failed · 2 refused to start.
// See verification/README.md.
// =============================================================================
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(new URL('../extension/writing-check.mjs', import.meta.url));
const M = await import(MODULE_PATH);
const SOURCE = readFileSync(MODULE_PATH, 'utf8');

const QUICK = process.argv.includes('--quick');
const CAP = M.MAX_INPUT_BYTES;
/** Wall-clock ceiling at the input cap. Slowest honest subject measures ~250 ms. */
const BUDGET_MS = QUICK ? 4000 : 1200;
/** Growth sizes: a factor-8 span, so linear is ~8x and quadratic is ~64x. */
const SIZES = QUICK ? [32768, 262144] : [65536, 131072, 262144, 524288];
const GROWTH_LIMIT = 3;      // multiples of the ideal linear factor
const NOISE_FLOOR_MS = 4;    // below this a ratio is timer jitter, not growth
const REPEATS = 3;
/**
 * A gate must fail FAST. Nothing can interrupt a running regex in-process, so
 * every subject is escalated from a small probe upwards and abandoned the
 * moment it breaks a ceiling scaled to the size in hand. Without this the gate
 * inherits the very cost it exists to reject: reinstating the old inline-code
 * pattern made this file run for over 400 seconds before saying anything, which
 * in practice reads as a hung suite rather than as a failure. The slack is wide
 * (a linear subject sits 20x under its ceiling at every size), so the escalation
 * only ever trips on genuine blow-up.
 */
const PROBE_SIZE = 8192;
const CEILING_SLACK = 4;
const MIN_CEILING_MS = 50;

// ------------------------------------------------------------------ report --
let pass = 0, fail = 0;
const reported = [];
function check(id, ok, detail, observed) {
  reported.push(id);
  console.log(`CHECK ${id.padEnd(26)} ${(ok ? 'PASS' : 'FAIL').padEnd(5)} — ${detail}`);
  if (!ok && observed !== undefined) console.log(`      observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}

// -------------------------------------------------------------- generators --
// Every generator is a fixed string repeated to length. Each is chosen to be the
// WORST case for its subject, which for a backtracking pattern is almost always
// input that ALMOST matches and then fails.
// Sized in UTF-8 BYTES, because MAX_INPUT_BYTES is: a generator holding an em
// dash or a curly quote would otherwise build an input the checker refuses.
const rep = (unit) => (n) => unit.repeat(Math.max(1, Math.floor(n / Buffer.byteLength(unit))));

/**
 * source -> { gen } for a pattern that scans text, or { bounded } naming why it
 * cannot scale. `gen` may be one generator or several.
 */
const COVERAGE = {
  // --- normalizeMarkdown, whole-input scans -------------------------------
  '^( {0,3})(`{3,}|~{3,})[^\\n]*(?:\\n|$)': { gen: { fence: rep('```\n'), 'fence-unclosed': rep('   ``') } },
  '^(?: {4,}(?![-+*]|\\d+[.)]\\s)\\S).*$': { gen: { indented: rep('    x\n'), 'indented-spaces': rep(' ') } },
  '^(?:diff --git |@@ |--- |\\+\\+\\+ ).*$': { gen: { 'git-diff': rep('--- a\n') } },
  '^[^\\S\\n]*\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d\\d:?\\d\\d)?\\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\\b.*$':
    { gen: { 'log-blank': rep(' \n'), 'log-timestamps': rep('2026-01-01T00:00:00 \n'), 'log-real': rep('2026-01-01T00:00:00 INFO x\n') } },
  '\\b(?:https?:\\/\\/|www\\.)[^\\s<>()]+': { gen: { url: rep('www.'), 'url-long': rep('www.aaaaaaaa ') } },
  '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]+': { gen: { 'report-controls': rep('\u001b\u0007\u202e a') } },
  '[^A-Za-z0-9._/@:+-]': { gen: { 'report-id-unsafe': rep('safe id\n') } },
  '^(?:ALL_CLEAR|Writing|NOT|FINDINGS|STE)$': { gen: { 'report-id-reserved': rep('ALL_CLEAR') } },
  '[⟦⟧]': { gen: { 'excerpt-delimiters': rep('⟦hostile⟧') } },
  '<(?:https?:\\/\\/|mailto:)': { gen: { 'autolink-open': rep('<https://') } },
  '[^>\\s]*': { gen: { 'autolink-run': rep('<https://a>') } },
  '`+': { gen: { 'tick-runs': rep('`a'), 'tick-solid': rep('`') } },
  '[A-Za-z0-9_.-]+': { gen: { 'path-segments': rep('a/b '), 'path-nosep': rep('a') } },

  // --- block and sentence structure ---------------------------------------
  '^\\s*\\|.*\\|\\s*$': { gen: { 'table-row': (n) => '|' + 'a'.repeat(n - 1) } },
  '^\\s*\\|?|\\|?\\s*$': { gen: { 'table-trim': (n) => '|' + 'a'.repeat(n - 1) } },
  '^\\s*\\|?': { gen: { 'table-lead': (n) => '|' + 'a'.repeat(n - 1), 'table-lead-spaces': (n) => ' '.repeat(n - 1) + '|' } },
  '(?<=\\n)': { gen: { 'line-split': rep('a\n') } },
  '[\\r\\n]+$': { gen: { 'line-strip': rep('a') } },
  '[A-Za-z]\\.[A-Za-z]\\.$': { bounded: 'applied to a 4-character window around one period' },
  '["\'”’\\])}]': { bounded: 'applied to one character' },
  '[.!?]': { bounded: 'applied to one character' },
  '[A-Za-z]': { bounded: 'applied to one character or one already-bounded slice' },

  // --- tokens and rules ----------------------------------------------------
  '[\\p{L}\\p{N}]+(?:[\'’][\\p{L}]+)*(?:-[\\p{L}\\p{N}]+(?:[\'’][\\p{L}]+)*)*': { gen: { word: rep("a-a' ") } },
  ';': { gen: { semicolon: rep(';') } },
  '\\b(?:i|you|we|they|he|she|it|that|there|here|what|who|how|where|when|why|let)(?:n[\'’]t|[\'’](?:re|ll|ve|d|m|s))\\b|\\b(?:is|are|was|were|do|does|did|has|have|had|can|could|should|would|will|must|might|need|dare|wo|sha)n[\'’]t\\b':
    { gen: { contraction: rep("it'"), 'contraction-real': rep("it isn't ") } },
  '(?<!\\/)\\b[\\p{L}]+\\/[\\p{L}]+\\b(?!\\/)': { gen: { slashed: rep('a'), 'slashed-real': rep('and/or ') } },
  '\\(([^()]*)\\)': { gen: { 'paren-open': rep('('), 'paren-real': rep('(is a) ') } },
  '(?:—|\\s–\\s)([^—–\\n]+?)(?:—|\\s–\\s)': { gen: { 'dash-aside': rep('—a'), 'dash-open': rep('—') } },
  '(?:,\\s*then\\s+|\\band\\s+then\\s+|\\band\\s+)([A-Za-z][A-Za-z\'-]*)': { gen: { 'multicmd-and': rep('and '), 'multicmd-comma': rep(', ') } },
  '\\b(?:[A-Za-z0-9_-]+\\.)+[A-Za-z]{1,8}\\b': { gen: { 'dotted-run': rep('a'), 'dotted-seg': rep('ab.') } },
  '\\b[A-Za-z_]*_[A-Za-z0-9_-]+\\b': { gen: { underscore: rep('_'), 'underscore-word': rep('a_b ') } },
  '\\b[a-z]+[A-Z][A-Za-z0-9]*\\b': { gen: { camel: rep('a'), 'camel-real': rep('aB ') } },
  '“[^”\\n]*—[^”\\n]*”|"[^"\\n]*—[^"\\n]*"': { gen: { 'quoted-dash': rep('"a—a"'), 'quoted-open': rep('"a') } },
  '“[^”\\n]*—[^”\\n]*”': { gen: { 'curly-dash': rep('“a—a”') } },
  '"[^"\\n]*—[^"\\n]*"': { gen: { 'straight-dash': rep('"a—a"') } },

  // --- CLI and small helpers ----------------------------------------------
  '\\r?\\n': { gen: { 'crlf-split': rep('a\r\n') } },
  '^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@': { gen: { 'hunk-digits': (n) => '@@ -' + '1'.repeat(n - 4) } },
  '\\s+': { gen: { 'ws-collapse': rep(' a') } },
  '\\s': { bounded: 'applied to one character' },
  '\\d': { bounded: 'applied to one character' },
  '\\p{L}': { bounded: 'applied to one already-bounded token' },
  '’': { bounded: 'applied to one already-bounded token' },
  '^\\s{0,3}#{1,6}\\s+': { gen: { heading: (n) => '#'.repeat(Math.min(n, 8)) + 'a'.repeat(Math.max(0, n - 8)) } },
  '^\\s{0,3}>\\s?': { gen: { blockquote: (n) => '>' + 'a'.repeat(n - 1) } },
  '^\\s*(?:[-+*]|\\d+[.)])\\s+': { gen: { 'list-item': (n) => '- ' + 'a'.repeat(n - 2) } },
  '(?:ed|es)$': { bounded: 'applied to one already-bounded token' },
  's$': { bounded: 'applied to one already-bounded token' },
  'ly$': { bounded: 'applied to one already-bounded token' },
  'ed$': { bounded: 'applied to one already-bounded token' },
  'ing$': { bounded: 'applied to one already-bounded token' },
  '\\t': { bounded: 'applied to one diff header line' },
  '^(json|text)$': { bounded: 'applied to one command-line argument' },
};

/** The whole-module passes, driven end to end at the same sizes. */
const PASSES = {
  'pass:normalizeMarkdown': [(n) => M.normalizeMarkdown(n), { 'md-mixed': rep('a `b` <!--c--> <https://d.test/e> f\n') }],
  'pass:makeBlocks': [(n) => M.makeBlocks(n), { 'blocks-many': rep('A.\n\n'), 'blocks-one': rep('word ') }],
  'pass:segmentSentences': [(n) => M.segmentSentences(n), { 'sent-periods': rep('A. '), 'sent-abbrev': rep('e.g. ') }],
  'pass:wordTokens': [(n) => M.wordTokens(n), { 'tok-hyphen': rep("a-b'c ") }],
  'pass:scanHtmlComments': [(n) => M.scanHtmlComments(n), { 'html-open': rep('<!--'), 'html-closed': rep('<!--a-->') }],
  'pass:scanAutolinks': [(n) => M.scanAutolinks(n), { 'auto-open': rep('<https://'), 'auto-closed': rep('<https://a> ') }],
  'pass:scanInlineCode': [(n) => M.scanInlineCode(n), { 'code-solid': rep('`'), 'code-pairs': rep('`a'), 'code-ragged': rep('`````' + '`x'.repeat(40)) }],
  'pass:scanLogLines': [(n) => M.scanLogLines(n), { 'log-blank2': rep(' \n'), 'log-real2': rep('2026-01-01T00:00:00 INFO x\n') }],
  'pass:scanPathTokens': [(n) => M.scanPathTokens(n), { 'path-flat': rep('a'), 'path-chain': rep('a/b/c ') }],
  'pass:quotedDashSpans': [(n) => M.quotedDashSpans(n), { 'qd-open': rep('"a'), 'qd-pairs': rep('"a—a" ') }],
  // The end-to-end shapes the three reviews filed, each the input that stalled.
  'pass:checkText': [(n) => M.checkText(n), {
    'repro-html': rep('<!--'),
    'repro-ticks': rep('`'),
    'repro-logblank': rep(' \n'),
    'repro-autolink': rep('<https://'),
    'repro-path': rep('a'),
    'repro-quoted-dash': rep('"q—q" a—x—a "'),
    'repro-bare-dash': rep('a—x—a '),
    'repro-prose': rep('The unit is connected and the operator then starts it. '),
  }],
};

// ---------------------------------------------------------------- measuring --
function timeOnce(run, input) {
  const t = performance.now();
  run(input);
  return performance.now() - t;
}
/** min-of-REPEATS, but only after one run has cleared `ceiling`. */
function timeAt(run, make, size, ceiling) {
  const input = make(size);
  let best = timeOnce(run, input);
  if (best > ceiling) return { ms: best, aborted: true };
  for (let i = 1; i < REPEATS; i++) best = Math.min(best, timeOnce(run, input));
  return { ms: best, aborted: false };
}
const runnerFor = (re) => (input) => {
  if (re.flags.includes('g') || re.flags.includes('y')) { re.lastIndex = 0; for (const _m of input.matchAll(re)) { /* drain */ } }
  else re.test(input);
};

/**
 * One subject at every size plus the cap. Returns the verdict and the line.
 * A subject fails on either rule; the message always names the generator, so a
 * failure points at an input rather than at a pattern in the abstract.
 */
function measure(label, run, make, sizes = SIZES, capSize = CAP) {
  const ceiling = (n) => Math.max(MIN_CEILING_MS, BUDGET_MS * (n / capSize) * CEILING_SLACK);
  const probe = timeAt(run, make, PROBE_SIZE, ceiling(PROBE_SIZE));
  if (probe.aborted) {
    return { ok: false, growthOk: true, budgetOk: false, aborted: true,
      line: `${label} ABANDONED at ${PROBE_SIZE} bytes: ${probe.ms.toFixed(0)}ms breaks the ${ceiling(PROBE_SIZE).toFixed(0)}ms ceiling for that size` };
  }
  const times = [];
  for (const n of sizes) {
    const r = timeAt(run, make, n, ceiling(n));
    times.push(r.ms);
    if (r.aborted) {
      return { ok: false, growthOk: true, budgetOk: false, aborted: true,
        line: `${label} ABANDONED at ${n} bytes: ${r.ms.toFixed(0)}ms breaks the ${ceiling(n).toFixed(0)}ms ceiling for that size [${times.map((t) => t.toFixed(1)).join(', ')}]` };
    }
  }
  const cap = timeAt(run, make, capSize, BUDGET_MS);
  const sizeFactor = sizes[sizes.length - 1] / sizes[0];
  const growth = times[0] > 0 ? times[times.length - 1] / times[0] : 1;
  const measurable = times[times.length - 1] >= NOISE_FLOOR_MS;
  const growthOk = !measurable || growth <= sizeFactor * GROWTH_LIMIT;
  const budgetOk = cap.ms <= BUDGET_MS;
  return {
    ok: growthOk && budgetOk, growthOk, budgetOk, aborted: false, measurable, growth, capMs: cap.ms, times,
    line: `${label} cap=${cap.ms.toFixed(0)}ms growth=${growth.toFixed(1)}x/${sizeFactor}x` +
      `${measurable ? '' : ' (below noise floor — budget rule applies)'} [${times.map((t) => t.toFixed(1)).join(', ')}]`,
  };
}

// ------------------------------------------------------------------ roster --
// Extract every regex literal from the module source, so the table above cannot
// silently fall behind the code it claims to cover.
function extractRegexLiterals(src) {
  const out = [];
  let i = src.startsWith('#!') ? src.indexOf('\n') : 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; prev = 'lit'; continue;
    }
    if (c === '/' && !/^(?:lit|ident|\)|\])$/.test(prev)) {
      let j = i + 1, cls = false, closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') { closed = true; break; }
        j++;
      }
      if (closed) {
        let k = j + 1; while (k < src.length && /[a-z]/.test(src[k])) k++;
        out.push({ source: src.slice(i + 1, j), line: src.slice(0, i).split('\n').length });
        i = k; prev = 'lit'; continue;
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      prev = /^(?:return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/.test(src.slice(i, j)) ? 'op' : 'ident';
      i = j; continue;
    }
    if (c === ')' || c === ']') { prev = c; i++; continue; }
    if (!/\s/.test(c)) prev = 'op';
    i++;
  }
  return out;
}

const literals = extractRegexLiterals(SOURCE);
const seen = new Set(literals.map((r) => r.source));
const uncovered = [...seen].filter((s) => !(s in COVERAGE));
const stale = Object.keys(COVERAGE).filter((s) => !seen.has(s));
check(
  'roster',
  literals.length > 20 && uncovered.length === 0 && stale.length === 0,
  `every regex literal in the module is covered by a generator or a written reason (${literals.length} literals, ${seen.size} distinct)`,
  uncovered.length || stale.length ? { uncovered, stale } : (literals.length > 20 ? undefined : 'extractor found too few literals to be believable'),
);

// ------------------------------------------------------------------- sweep --
const slow = [];
for (const [source, entry] of Object.entries(COVERAGE)) {
  if (!seen.has(source)) continue;
  if (entry.bounded) continue;
  for (const [genName, make] of Object.entries(entry.gen)) {
    const re = new RegExp(source, source.includes('\\p{') ? 'gu' : 'g');
    const r = measure(genName, runnerFor(re), make);
    if (!r.ok) slow.push(r.line + (r.aborted ? '' : r.budgetOk ? ' [growth]' : ' [budget]'));
    else if (r.capMs > BUDGET_MS / 4) slow.push('(near budget) ' + r.line);
  }
}
check('regex-scaling', slow.filter((s) => !s.startsWith('(near')).length === 0,
  `every scanning regex in the module grows no faster than ${GROWTH_LIMIT}x linear and finishes ${CAP} bytes inside ${BUDGET_MS} ms`,
  slow.length ? slow : undefined);

const slowPass = [];
for (const [id, [run, gens]] of Object.entries(PASSES)) {
  for (const [genName, make] of Object.entries(gens)) {
    const r = measure(`${id}/${genName}`, run, make);
    if (!r.ok) slowPass.push(r.line + (r.aborted ? '' : r.budgetOk ? ' [growth]' : ' [budget]'));
  }
}
check('pass-scaling', slowPass.length === 0,
  `every exported pass, and every reproduction shape the reviews filed, grows no faster than ${GROWTH_LIMIT}x linear and finishes ${CAP} bytes inside ${BUDGET_MS} ms`,
  slowPass.length ? slowPass : undefined);

// ------------------------------------------------------------------ canary --
// A gate that has stopped discriminating looks exactly like a clean run. The
// canary is the html-comment pattern EXACTLY as it shipped before this fix, on
// exactly the input that stalled it, so what is re-proved here is that these
// thresholds catch the real defect and not merely some textbook shape.
//
// Its sizes are its own and small: at the module's cap this pattern took 70
// SECONDS, which is the whole point of it, so measuring it there would make the
// gate cost what the defect cost. The GROWTH rule is size-relative and is what
// the canary validates; the budget rule is a plain comparison with nothing to
// go subtly wrong, and every real subject above prints its cap figure anyway.
const CANARY_SIZES = [8192, 16384, 32768, 65536];
const canary = measure('canary', runnerFor(/<!--[\s\S]*?-->/g), rep('<!--'), CANARY_SIZES, CANARY_SIZES[CANARY_SIZES.length - 1]);
check('canary', canary.growthOk === false,
  'the pre-fix html-comment pattern, on the input that stalled it, is still judged SUPERLINEAR by these very thresholds — so a clean sweep above means the rules bite rather than that they stopped discriminating',
  canary.growthOk ? `canary was judged LINEAR — the thresholds no longer discriminate: ${canary.line}` : undefined);

// ------------------------------------------------------------------ output --
check('cap-output', (() => {
  // SC7: a 1 MiB input must not amplify into tens of MB of report.
  const r = M.checkText(rep('A.\n\n')(CAP));
  const bytes = Buffer.byteLength(JSON.stringify(r));
  return r.blocks > M.MAX_BLOCK_DETAILS && r.blockDetails.length === M.MAX_BLOCK_DETAILS &&
    r.blockDetailsTruncated === true && bytes < 4 * 1024 * 1024;
})(), `a ${CAP}-byte input reports at most ${M.MAX_BLOCK_DETAILS} block details and stays under 4 MB of JSON (SC7)`);

check('cap-stripped', (() => {
  const r = M.checkText(rep('`a')(CAP));
  return r.stripped.length === M.MAX_STRIPPED && r.strippedTruncated === true && r.omittedStripped > 0;
})(), `a ${CAP}-byte input reports at most ${M.MAX_STRIPPED} stripped spans and says how many it dropped (SC7)`);

console.log(`== summary: ${pass} pass, ${fail} fail (${reported.length} checks) ==`);
process.exitCode = fail > 0 ? 1 : 0;
