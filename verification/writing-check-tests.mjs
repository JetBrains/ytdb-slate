#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkRecord, checkText, measureWritingTurn, normalizeMarkdown, segmentSentences, wordTokens, run, formatText,
  recordsFromFiles, recordsFromUnifiedDiff, NOT_CHECKED, MAX_FINDINGS, MAX_INPUT_BYTES,
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

console.log(`1..${passed}`);
console.log(`# ${passed} tests passed`);
