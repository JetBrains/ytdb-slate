#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkRecord, checkText, measureWritingTurn, normalizeMarkdown, makeBlocks, segmentSentences, wordTokens, run, formatText,
  recordsFromFiles, recordsFromUnifiedDiff, NOT_CHECKED, MAX_FINDINGS, MAX_INPUT_BYTES,
  MAX_STRIPPED, MAX_BLOCK_DETAILS,
  scanHtmlComments, scanAutolinks, scanInlineCode, scanLogLines, scanPathTokens,
  sanitizeReportId, REGULAR_FILE_OPEN_FLAGS,
} from '../extension/writing-check.mjs';

const CHECKER = fileURLToPath(new URL('../extension/writing-check.mjs', import.meta.url));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok ${passed + 1} - ${name}`); throw e; }
}
const check = text => checkRecord({ id: 'fixture', text });
const ids = result => result.findings.map(f => f.id);
const has = (result, id) => ids(result).includes(id);
const lacks = (result, id) => !has(result, id);
const words = n => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');

test('SENT20 warns at 21 words', () => {
  const r = check(words(21) + '.');
  assert.equal(has(r, 'SENT20'), true); assert.equal(r.findings.find(f => f.id === 'SENT20').class, 'warning');
});
test('SENT20 stays silent at 20 words', () => assert.equal(lacks(check(words(20) + '.'), 'SENT20'), true));
test('SENT25 fails at 26 words without a duplicate SENT20', () => {
  const r = check(words(26) + '.');
  assert.equal(has(r, 'SENT25'), true); assert.equal(lacks(r, 'SENT20'), true);
  assert.equal(r.findings.find(f => f.id === 'SENT25').class, 'fail');
});
test('SENT25 stays silent at 25 words', () => assert.equal(lacks(check(words(25) + '.'), 'SENT25'), true));
test('declared text types have no effect and are absent from output', () => {
  const r = checkRecord({ textType: 'descriptive', steType: 'procedural', text: words(23) + '.' });
  assert.equal(has(r, 'SENT20'), true); assert.equal('textType' in r, false); assert.equal('thresholdPolicy' in r, false);
});
test('PARA6 fires at seven paragraph sentences',  () => assert.equal(has(check('One. Two. Three. Four. Five. Six. Seven.'), 'PARA6'), true));
test('PARA6 stays silent at six sentences', () => assert.equal(lacks(check('One. Two. Three. Four. Five. Six.'), 'PARA6'), true));
test('SEMICOLON fires in prose', () => assert.equal(has(check('Open the panel; inspect the seal.'), 'SEMICOLON'), true));
test('SEMICOLON stays silent without one', () => assert.equal(lacks(check('Open the panel. Inspect the seal.'), 'SEMICOLON'), true));
test('CONTRACTION fires for a verb contraction', () => assert.equal(has(check("It isn't ready."), 'CONTRACTION'), true));
test("possessive 's is not a contraction", () => assert.equal(lacks(check("The pump's cover is red."), 'CONTRACTION'), true));
test('PARENTHETICAL_PAREN fires for a finite parenthesized clause', () => assert.equal(has(check('Open the valve (which is near the pump).'), 'PARENTHETICAL_PAREN'), true));
test('PARENTHETICAL_PAREN stays silent for a label', () => assert.equal(lacks(check('Use connector (type A).'), 'PARENTHETICAL_PAREN'), true));
test('PARENTHETICAL_DASH fires for an em-dash aside', () => assert.equal(has(check('The valve—when it is cold—moves slowly.'), 'PARENTHETICAL_DASH'), true));
test('PARENTHETICAL_DASH stays silent without an aside', () => assert.equal(lacks(check('The valve moves slowly.'), 'PARENTHETICAL_DASH'), true));
test('SLASHED fires for and/or', () => assert.equal(has(check('Select and/or replace the unit.'), 'SLASHED'), true));
test('SLASHED stays silent for a filesystem path', () => assert.equal(lacks(check('Read /usr/bin/x now.'), 'SLASHED'), true));
test('PASSIVE fires for be plus irregular participle', () => assert.equal(has(check('The report was written yesterday.'), 'PASSIVE'), true));
test('PASSIVE suppresses a common equipment-state adjective', () => assert.equal(lacks(check('The unit is configured.'), 'PASSIVE'), true));
test('INGFORM fires for a non-initial non-progressive ing token', () => assert.equal(has(check('The crew uses rotating equipment.'), 'INGFORM'), true));
test('INGFORM stays silent after a be-form', () => assert.equal(lacks(check('The pump is rotating.'), 'INGFORM'), true));
test('NOUNCLUSTER fires for four content tokens', () => assert.equal(has(check('Main engine fuel pump controller fails.'), 'NOUNCLUSTER'), true));
test('NOUNCLUSTER stays silent when function words break runs', () => assert.equal(lacks(check('Fuel pump in the main bay fails.'), 'NOUNCLUSTER'), true));
test('MULTICMD fires for comma-then command shape', () => assert.equal(has(check('Open the panel, then close the valve.'), 'MULTICMD'), true));
test('MULTICMD stays silent for one command', () => assert.equal(lacks(check('Open the panel carefully.'), 'MULTICMD'), true));

test('fenced code produces no findings', () => {
  const r = check('Before.\n\n```js\nconst x = "isn\\\'t; and/or"; // ' + words(30) + '\n```\n\nAfter.');
  assert.deepEqual(r.findings, []); assert.equal(r.stripped.some(x => x.type === 'fenced-code'), true);
});
test('indented code produces no findings', () => {
  const r = check('    This is code-like prose with a semicolon; and ' + words(25) + '.');
  assert.deepEqual(r.findings, []); assert.equal(r.stripped.some(x => x.type === 'indented-code'), true);
});
test('git diff lines produce no findings', () => {
  const r = check('diff --git a/file.ts b/file.ts; + const value = 1; - const value = 2');
  assert.deepEqual(r.findings, []); assert.equal(r.stripped.some(x => x.type === 'git-diff'), true);
});
test('timestamped log lines produce no findings', () => {
  const r = check('2026-08-03T05:00:00Z ERROR request failed; retrying now.');
  assert.deepEqual(r.findings, []); assert.equal(r.stripped.some(x => x.type === 'log-line'), true);
});
test('path-like tokens do not create noun-cluster advisories', () => assert.equal(lacks(check('Read /usr/local/share/project/configuration/very-long-file-name.json before operation.'), 'NOUNCLUSTER'), true));
test('em dashes inside quoted strings are literal', () => assert.deepEqual(check('The label says “left — hidden — right” and the parser keeps it.').findings, []));
test('inline-code em dash produces no parenthetical finding', () => assert.equal(lacks(check('Use `left—hidden—right` now.'), 'PARENTHETICAL_DASH'), true));
test('URL content is stripped and recorded', () => {
  const r = check('See https://example.test/a;b and continue.');
  assert.equal(lacks(r, 'SEMICOLON'), true); assert.equal(r.stripped.some(x => x.type === 'url'), true);
});
test('HTML comment content is stripped', () => assert.equal(check('Safe. <!-- It isn\'t; hidden. --> Done.').findings.length, 0));
test('e.g. does not split a sentence', () => assert.equal(segmentSentences('Use a tool, e.g. a wrench, now.').length, 1));
test('i.e. does not split a sentence', () => assert.equal(segmentSentences('Use one unit, i.e. the pump, now.').length, 1));
test('v1.2.3 does not split a sentence', () => assert.equal(segmentSentences('Install v1.2.3 before operation.').length, 1));
test('/usr/bin/x does not split a sentence', () => assert.equal(segmentSentences('Run /usr/bin/x before operation.').length, 1));
test('decimal does not split a sentence', () => assert.equal(segmentSentences('Set the value to 1.25 units.').length, 1));
test('ellipsis is treated as one sentence boundary', () => assert.equal(segmentSentences('Wait... Continue now.').length, 2));
test('sentence-final punctuation inside a quote terminates', () => assert.equal(segmentSentences('The label says "Stop." Continue now.').length, 2));
test('sentence-final punctuation inside parentheses terminates', () => assert.equal(segmentSentences('Do this (if needed.) Continue now.').length, 2));
test('hyphenated compound counts as one word', () => assert.equal(wordTokens('A high-pressure pump.').length, 3));
test('numeric-only token does not count as a word', () => assert.equal(wordTokens('Set 123 4.5 values.').length, 2));
test('markdown table row is excluded from SENT20 prose checks', () => {
  const row = `| ${words(30)} | value |`;
  const r = check(`| Name | Value |\n| --- | --- |\n${row}`);
  assert.equal(lacks(r, 'SENT20'), true); assert.equal(r.words, 0);
});
test('heading is excluded from prose sentence limits', () => assert.equal(lacks(check(`# ${words(30)}`), 'SENT20'), true));
test('list item is classified separately and checked as prose', () => {
  const r = check('- Open the valve; then wait.');
  assert.equal(r.blockDetails[0].type, 'list-item'); assert.equal(has(r, 'SEMICOLON'), true);
});
test('numbered procedure remains clean', () => assert.deepEqual(check('1. Open the panel.\n2. Close the valve.').findings, []));
test('URL query remains stripped', () => assert.deepEqual(check('See https://example.test/path?a=1&b=two; then continue.').findings, []));
test('nested lists remain clean', () => assert.deepEqual(check('- Main item\n  - Nested item\n    1. First nested step\n    2. Second nested step').findings, []));
test('bulleted sentence fragments remain clean', () => assert.deepEqual(check('- Verify input\n- Output path\n- No errors').findings, []));
test('quoted prose semicolon remains visible', () => assert.equal(has(check('The user wrote, “Open the panel; then inspect the seal.”'), 'SEMICOLON'), true));
test('curly quote en-dash aside remains visible', () => assert.equal(has(check('Use “the safe path” – when the input is valid – before release.'), 'PARENTHETICAL_DASH'), true));
test('200-word prose sentence keeps the highest length finding', () => { const r = check(words(200) + '.'); assert.equal(lacks(r, 'SENT20'), true); assert.equal(has(r, 'SENT25'), true); assert.equal(has(r, 'NOUNCLUSTER'), true); });
test('blockquote is classified separately', () => assert.equal(check('> The unit operates.').blockDetails[0].type, 'blockquote'));
test('stripped offsets preserve the original source length', () => {
  const text = 'α `hidden` omega'; const n = normalizeMarkdown(text);
  assert.equal(n.normalized.length, text.length); assert.equal(n.normalized.indexOf('omega'), text.indexOf('omega'));
});
test('finding offsets select original text', () => {
  const text = 'Lead text. It is not ready; stop.'; const f = check(text).findings.find(x => x.id === 'SEMICOLON');
  assert.equal(text.slice(f.offset.start, f.offset.end), ';');
});
test('aggregate reports advisories separately from fail-level findings', () => {
  const result = run([{ id: 'a', text: 'The report was written.' }]);
  assert.equal(result.aggregate.rules.PASSIVE.findings, 1); assert.equal(result.aggregate.failFindings, 0); assert.equal(result.aggregate.advisoryFindings, 1);
});
test('aggregate gives count, record count, and rate for every rule', () => {
  const x = run([{ text: 'Use and/or inspect.' }]).aggregate.rules.SLASHED;
  assert.equal(x.findings, 1); assert.equal(x.records, 1); assert.equal(x.ratePer1000Words > 0, true);
});
test('aggregate includes all requested distributions', () => {
  const a = run([{ text: 'One two. Three.' }]).aggregate;
  for (const key of ['sentenceLength', 'wordsPerRecord', 'sentencesPerParagraph']) assert.equal(typeof a[key].median, 'number');
});
test('NOT CHECKED is a fixed nonempty reason list', () => {
  assert.equal(NOT_CHECKED.length, 5); assert.equal(NOT_CHECKED.every(x => x.id && x.reason), true);
});
test('text format names NOT CHECKED and findings', () => {
  const text = formatText(run([{ id: 'r', text: 'Use and/or inspect.' }]));
  assert.match(text, /NOT CHECKED:/); assert.match(text, /SLASHED/);
});
test('empty input produces valid zero aggregates', () => {
  const a = run([]).aggregate; assert.equal(a.records, 0); assert.equal(a.sentenceLength.max, 0);
});
test('house-style rules never contribute to fail-level findings', () => {
  const a = run([{ text: 'Select and/or replace it (which is permitted). The valve—when it is cold—moves.' }]).aggregate;
  assert.equal(a.houseStyleFindings, 3); assert.equal(a.failFindings, 0);
});
test('finding output is capped', () => {
  const result = run([{ text: 'Open; '.repeat(MAX_FINDINGS + 20) }]);
  assert.equal(result.records[0].findings.length, MAX_FINDINGS);
  assert.equal(result.aggregate.findingsTruncated, true); assert.equal(result.aggregate.omittedFindings > 0, true);
});
test('clean text function checks extension-supplied text', () => assert.equal(has(checkText('Open the panel; stop.'), 'SEMICOLON'), true));
test('direct file mode creates one record per file', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'writing-check-files-'));
  try {
    const a = join(dir, 'a.md'), b = join(dir, 'b.txt'); fs.writeFileSync(a, 'One.'); fs.writeFileSync(b, 'Two.');
    assert.deepEqual(recordsFromFiles([a, b]).map(r => r.text), ['One.', 'Two.']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('unified diff mode checks only added lines', () => {
  const diff = 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n-Old text;\n+New text;\n Context line with and/or text.\n';
  const records = recordsFromUnifiedDiff(diff);
  assert.equal(records.length, 1); assert.equal(records[0].text, 'New text;');
  const result = run(records); assert.equal(result.aggregate.rules.SEMICOLON.findings, 1); assert.equal(result.aggregate.rules.SLASHED.findings, 0);
});
test('unified diff mode joins adjacent added prose lines', () => {
  const records = recordsFromUnifiedDiff('+++ b/a.md\n@@ -0,0 +4,2 @@\n+First added line\n+continues here.\n');
  assert.deepEqual(records.map(r => [r.id, r.text]), [['a.md:4', 'First added line\ncontinues here.']]);
});
test('CLI unified-diff mode reports only an added finding', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'writing-check-diff-'));
  try {
    const path = join(dir, 'change.diff');
    fs.writeFileSync(path, '--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-Old and/or text.\n+New text; stop.\n');
    const p = spawnSync(process.execPath, [CHECKER, '--diff', path], { encoding: 'utf8' });
    assert.equal(p.status, 0); const result = JSON.parse(p.stdout);
    assert.equal(result.aggregate.rules.SEMICOLON.findings, 1); assert.equal(result.aggregate.rules.SLASHED.findings, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('CLI refuses a five-MiB regular file before reading it', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'writing-check-large-'));
  try {
    const path = join(dir, 'large.md'); fs.writeFileSync(path, Buffer.alloc(5 * 1024 * 1024, 0x61));
    const p = spawnSync(process.execPath, [CHECKER, '--file', path], { encoding: 'utf8' });
    assert.notEqual(p.status, 0); assert.match(p.stderr, new RegExp(`${MAX_INPUT_BYTES}-byte`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('writing status counts only fail findings on completed assistant text', () => {
  const counters = { measuredTurns: 0, findingTurns: 0 };
  measureWritingTurn({ role: 'assistant', content: 'This is a clean turn.' }, { checkText: text => ({ findings: [] }) }, counters);
  measureWritingTurn({ role: 'assistant', content: 'Open the panel; stop.' }, { checkText: text => ({ findings: [{ class: 'fail' }] }) }, counters);
  measureWritingTurn({ role: 'assistant', content: 'A warning.' }, { checkText: text => ({ findings: [{ class: 'warning' }] }) }, counters);
  measureWritingTurn({ role: 'user', content: 'Open the panel; stop.' }, { checkText: text => ({ findings: [{ class: 'fail' }] }) }, counters);
  assert.deepEqual(counters, { measuredTurns: 3, findingTurns: 1 });
});
test('writing status fails open when the checker throws', () => {
  const counters = { measuredTurns: 0, findingTurns: 0 };
  measureWritingTurn({ role: 'assistant', content: 'This message is too large.' }, { checkText: () => { throw new Error('cap'); } }, counters);
  assert.deepEqual(counters, { measuredTurns: 0, findingTurns: 0 });
});
test('writing status skips a capped assistant message', () => {
  const counters = { measuredTurns: 0, findingTurns: 0 };
  measureWritingTurn({ role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) }, { checkText: text => checkText(text) }, counters);
  assert.deepEqual(counters, { measuredTurns: 0, findingTurns: 0 });
});
test('CLI refuses a symlink to a special file', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'writing-check-link-'));
  try {
    const path = join(dir, 'zero'); fs.symlinkSync('/dev/zero', path);
    const p = spawnSync(process.execPath, [CHECKER, '--file', path], { encoding: 'utf8' });
    assert.notEqual(p.status, 0); assert.match(p.stderr, /regular file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --------------------------------------------------------------------------
// Scanner equivalence.
//
// Five quadratic regexes were replaced by linear scanners. The scanners are
// only safe if they match the SAME spans the regexes did, so each is pinned
// here against the exact pattern it replaced, on fixtures chosen for the edges
// the rewrite had to reason about: an unterminated opener, a nested one, an
// opener whose shorter suffix matches where the full run does not, a partner
// run with backticks to spare, whitespace-only lines before a log line (the
// case that decides where its span STARTS), and `//` inside a path, which the
// original refuses. Growth is a separate concern and lives in
// verification/writing-check-scaling.mjs.
const spansVia = (re, text) => {
  const out = [];
  for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
};
const EQUIVALENCE = [
  ['scanHtmlComments', scanHtmlComments, /<!--[\s\S]*?-->/g,
    ['', '<!--', '<!--a-->', '<!--a--><!--b', '<!--<!--x-->y-->', '<!-->', '<!----->', 'a<!--b-->c<!--d', '<!--\n-->']],
  ['scanAutolinks', scanAutolinks, /<(?:https?:\/\/|mailto:)[^>\s]+>/gi,
    ['', '<https://a>', '<https://a <https://b>', '<HTTPS://A>', '<mailto:a@b>', '<https://>', '<http://a><http://b>',
      '<https://a b>', 'x <https://a', '<https://<https://x>']],
  ['scanInlineCode', scanInlineCode, /(`+)(?!`)([^\n]*?)\1/g,
    ['', '`', '``', '`a`', '``a`', '`a``b`', '```x```', '``a\nb``', '`a`b`c`', '````', '`a``', '``a``b``', '`\n`', '``x`y``']],
  ['scanLogLines', scanLogLines, /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b.*$/gm,
    ['', '2026-01-01T00:00:00Z INFO a', '\n\n  2026-01-01T00:00:00Z INFO a', 'x\n\t \n \n2026-01-01T00:00:00Z ERROR e',
      '2026-01-01T00:00:00Z INFO a\n\n\n2026-01-02T00:00:00Z INFO b', '  2026-01-01T00:00:00 WARN w', '2026-01-01T00:00:00Z NOPE x']],
  ['scanPathTokens', scanPathTokens, /\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g,
    ['', 'a', 'a/b', '/a/b', '//a/b', 'a//b', 'a//b/c', 'a/b//c/d', 'see /x/y/ end', 'a.b/c-d_e/f', 'a/ /b', '/a', 'a/b/c/d']],
];
for (const [name, scanner, reference, fixtures] of EQUIVALENCE) {
  test(`${name} matches the regex it replaced on every fixture`, () => {
    for (const text of fixtures) {
      assert.deepEqual(scanner(text), spansVia(reference, text), `${name} diverged on ${JSON.stringify(text)}`);
    }
  });
}
test('scanners keep whole-record output identical for a mixed document', () => {
  const doc = 'Intro text.\n\n<!-- hidden; note -->\n\nUse `a; b` and <https://e.test/x?y=1>.\n\n' +
    '2026-01-01T00:00:00Z INFO started\n\n    indented; code\n\nSee /usr/local/share/x.json here.\n';
  const r = checkText(doc);
  assert.equal(r.stripped.map(s => s.type).join(','), 'html-comment,inline-code,autolink,log-line,indented-code');
  assert.equal(r.findings.some(f => f.id === 'SEMICOLON'), false);
});

test('stripped spans are capped and report the shortfall (SC7)', () => {
  // `a`a`a… pairs up, so two repeats yield roughly one span.
  const r = checkText('`a'.repeat((MAX_STRIPPED + 500) * 2));
  assert.equal(r.stripped.length, MAX_STRIPPED);
  assert.equal(r.strippedTruncated, true);
  assert.equal(r.omittedStripped > 0, true);
});
test('stripped spans below the cap are untouched and report no shortfall', () => {
  const r = checkText('`a` `b` `c`');
  assert.equal(r.strippedTruncated, false);
  assert.equal(r.omittedStripped, 0);
  assert.equal(r.stripped.length, 3);
});
test('block details are capped while the block count stays exact (SC7)', () => {
  const r = checkText('A.\n\n'.repeat(MAX_BLOCK_DETAILS + 200));
  assert.equal(r.blocks, MAX_BLOCK_DETAILS + 200);
  assert.equal(r.blockDetails.length, MAX_BLOCK_DETAILS);
  assert.equal(r.blockDetailsTruncated, true);
  assert.equal(r.omittedBlockDetails, 200);
});
test('block details below the cap are untouched', () => {
  const r = checkText('A.\n\nB.\n');
  assert.equal(r.blockDetailsTruncated, false);
  assert.equal(r.omittedBlockDetails, 0);
  assert.equal(r.blockDetails.length, 2);
});

// --------------------------------------------------------------------------
// BG2 — block offsets map back to the source.
//
// A paragraph's lines are trimmed and joined with one space, so past the first
// line a block position is NOT a source position: the indent, the trailing
// spaces and the newline are all gone. Every rule used to report
// `block.start + blockIndex`, which put 1370 of this repository's own 5057
// findings on the wrong character.
//
// The reviewer's point (TQ3) was that the paragraph-join mutation survived both
// suites untouched, so these assert EXACT source offsets. A join without the
// offset map moves them and the numbers below stop matching.

// Alpha beta gamma\n   delta; epsilon\nzeta eta.\n
// 0123456789...       ^20 delta      ^25 semicolon
const MULTILINE = 'Alpha beta gamma\n   delta; epsilon\nzeta eta.\n';
test('BG2 semicolon on a continuation line reports its true source offset', () => {
  const f = check(MULTILINE).findings.find(x => x.id === 'SEMICOLON');
  // Block text is 'Alpha beta gamma delta; epsilon zeta eta.', so the semicolon
  // sits at block index 22 and at source index 25. The join swallowed the
  // newline and the three-space indent.
  assert.equal(f.offset.start, 25);
  assert.equal(f.offset.end, 26);
  assert.equal(MULTILINE.slice(f.offset.start, f.offset.end), ';');
  assert.equal(MULTILINE.slice(f.offset.start - 5, f.offset.end), 'delta;');
});
test('BG2 a finding on the third line is displaced by both joins', () => {
  // Three spaces, not four: four would make the line indented code and blank it.
  const doc = 'One two;\n  three four;\n   five six;\n';
  const at = check(doc).findings.filter(x => x.id === 'SEMICOLON').map(x => x.offset.start);
  assert.deepEqual(at, [7, 21, 34]);
  for (const i of at) assert.equal(doc[i], ';');
});
test('BG2 a span crossing a line break covers the source newline', () => {
  const doc = 'The valve (which\nis near it) moves.\n';
  const f = check(doc).findings.find(x => x.id === 'PARENTHETICAL_PAREN');
  assert.equal(doc.slice(f.offset.start, f.offset.end), '(which\nis near it)');
});
test('BG2 a list item indented after its marker starts at its text', () => {
  const doc = '-    Open the panel; stop.\n';
  const f = check(doc).findings.find(x => x.id === 'SEMICOLON');
  assert.equal(doc.slice(f.offset.start, f.offset.end), ';');
  assert.equal(checkText(doc).blockDetails[0].start, 5);
});
test('BG2 every block is a verbatim run of the normalized source', () => {
  const doc = MULTILINE + '\n> quoted;   text\n>    deeper; text\n\n-   item; one\n\n| a; b | c |\n\n# head; ing\n';
  const normalized = normalizeMarkdown(doc).normalized;
  const blocks = makeBlocks(normalized);
  let mapped = 0;
  for (const b of blocks) {
    if (b.segments) {
      mapped++;
      assert.equal(b.segments.length > 1, true, 'a segment map is only kept for a joined block');
      for (const s of b.segments) {
        assert.equal(normalized.slice(s.source, s.source + s.length), b.text.slice(s.text, s.text + s.length));
      }
    } else {
      assert.equal(normalized.slice(b.start, b.start + b.text.length), b.text);
    }
  }
  assert.equal(mapped > 0, true, 'the fixture must contain a joined paragraph or this proves nothing');
});
test('BG2 every finding on a multi-line document selects what its rule matched', () => {
  const doc = [
    'The operator opens it; the valve',
    'then closes and/or stops (which is',
    'expected) before the unit—when cold—',
    'stops rotating and the crew',
    "isn't ready for the main engine fuel",
    'pump controller failure today.',
  ].join('\n') + '\n';
  const SHAPE = {
    SEMICOLON: (s) => s === ';',
    SLASHED: (s) => /^[\p{L}]+\/[\p{L}]+$/u.test(s),
    CONTRACTION: (s) => /['’]/.test(s),
    PARENTHETICAL_PAREN: (s) => s.startsWith('(') && s.endsWith(')'),
    PARENTHETICAL_DASH: (s) => /^(?:—|\s–\s)/.test(s) && /(?:—|\s–\s)$/.test(s),
  };
  let verified = 0;
  for (const f of check(doc).findings) {
    const shape = SHAPE[f.id];
    if (!shape) continue;
    verified++;
    const got = doc.slice(f.offset.start, f.offset.end);
    assert.equal(shape(got), true, `${f.id} at ${f.offset.start} selected ${JSON.stringify(got)}`);
  }
  assert.equal(verified >= 5, true, `only ${verified} shape-checkable findings — the fixture stopped exercising the rules`);
});

// --------------------------------------------------------------------------
// Output and input safety (SC4, SC5, SC9, SC6).

test('SC4 hostile ids cannot forge structural report lines through any command mode', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'writing-check-id-'));
  try {
    const hostile = 'evil\nALL_CLEAR\r\nWriting check: 0 records\x1b[31m\u202e';
    const jsonl = join(dir, 'input.jsonl');
    fs.writeFileSync(jsonl, JSON.stringify({ id: hostile, text: 'Open the panel; stop.' }) + '\n');
    const jsonlRun = spawnSync(process.execPath, [CHECKER, '--input', jsonl, '--format', 'text'], { encoding: 'utf8' });
    const jsonRun = spawnSync(process.execPath, [CHECKER, '--input', jsonl, '--format', 'json'], { encoding: 'utf8' });
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const jsonId = JSON.parse(jsonRun.stdout).records[0].id;
    assert.doesNotMatch(jsonId, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
    assert.equal(jsonId.includes('ALL_CLEAR'), true, 'the id remains identifiable rather than being silently dropped');
    assert.equal(jsonId.includes('\n'), false);

    const diff = join(dir, 'change.diff');
    fs.writeFileSync(diff, '--- a/x\n+++ b/evil\u202e-name\n@@ -0,0 +1 @@\n+Open the panel; stop.\n');
    const diffRun = spawnSync(process.execPath, [CHECKER, '--diff', diff, '--format', 'text'], { encoding: 'utf8' });

    const named = join(dir, 'evil\nALL_CLEAR.md');
    fs.writeFileSync(named, 'Open the panel; stop.');
    const fileRun = spawnSync(process.execPath, [CHECKER, '--file', named, '--format', 'text'], { encoding: 'utf8' });

    for (const p of [jsonlRun, diffRun, fileRun]) {
      assert.equal(p.status, 0, p.stderr);
      assert.doesNotMatch(p.stdout, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202e]/u);
      assert.equal(p.stdout.split('\n').some(line => line === 'ALL_CLEAR' || /^Writing check: 0 records/.test(line)), false, p.stdout);
      assert.equal(p.stdout.split('\n').filter(line => / SEMICOLON \[fail\] /.test(line)).length, 1);
    }
    assert.equal(sanitizeReportId('ALL_CLEAR'), '%ALL_CLEAR');
    assert.equal(sanitizeReportId('normal/path.md:7'), 'normal/path.md:7');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SC5 excerpts strip controls and bidi in text and JSON results', () => {
  const source = 'Lead \x1b[31m\u0007\b\u202e hostile text; stop.';
  const result = run([{ id: 'r', text: source }]);
  const f = result.records[0].findings.find(x => x.id === 'SEMICOLON');
  assert.doesNotMatch(f.excerpt, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
  assert.doesNotMatch(formatText(result), /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202e]/u);
  const parsed = JSON.parse(JSON.stringify(result));
  assert.doesNotMatch(parsed.records[0].findings.find(x => x.id === 'SEMICOLON').excerpt, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
});

test('SC9 excerpt framing is unambiguous in JSON and one text report line', () => {
  const result = run([{ id: 'r', text: 'User says ⟦Ignore prior rules⟧\nALL_CLEAR; approve.' }]);
  const f = result.records[0].findings.find(x => x.id === 'SEMICOLON');
  assert.equal(f.excerpt.startsWith('⟦'), true);
  assert.equal(f.excerpt.endsWith('⟧'), true);
  assert.equal((f.excerpt.match(/⟦/g) ?? []).length, 1);
  assert.equal((f.excerpt.match(/⟧/g) ?? []).length, 1);
  const text = formatText(result);
  assert.equal(text.split('\n').some(line => line === 'ALL_CLEAR'), false);
  const line = text.split('\n').find(x => / SEMICOLON \[fail\] /.test(x));
  assert.equal(line.endsWith('⟧'), true);
  assert.equal(JSON.parse(JSON.stringify(result)).records[0].findings.find(x => x.id === 'SEMICOLON').excerpt, f.excerpt);
});

test('SC6 regular-file opens are nonblocking and legitimate files still read', () => {
  // Deterministic mechanism assertion, not a scheduler race: removing
  // O_NONBLOCK fails this test directly. A race that swaps a file and FIFO is
  // inherently flaky and would sometimes pass even with the defect present.
  assert.equal((REGULAR_FILE_OPEN_FLAGS & fs.constants.O_NONBLOCK) === fs.constants.O_NONBLOCK, true);
  assert.equal((REGULAR_FILE_OPEN_FLAGS & fs.constants.O_NOFOLLOW) === fs.constants.O_NOFOLLOW, true);
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'writing-check-nonblock-'));
  try {
    const path = join(dir, 'ordinary.md');
    fs.writeFileSync(path, 'Ordinary file text.');
    assert.equal(recordsFromFiles([path])[0].text, 'Ordinary file text.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`1..${passed}`);
console.log(`# ${passed} tests passed`);
