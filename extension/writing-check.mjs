#!/usr/bin/env node
/**
 * Dictionary-free STE proxy. This reports surface facts and noisy advisories;
 * it does not establish ASD-STE100 conformance and embeds no controlled vocabulary.
 */
import fs from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_RECORDS = 10000;
export const MAX_FINDINGS = 1000;

export const NOT_CHECKED = [
  { id: 'APPROVED_WORD', reason: 'Approved-word membership needs an authorized controlled dictionary.' },
  { id: 'APPROVED_MEANING_POS', reason: 'Approved meaning and part of speech need authorized dictionary data and contextual review.' },
  { id: 'NOUNCLUSTER_CORRECTNESS', reason: 'The token-run heuristic cannot decide whether a noun cluster is linguistically correct or an approved technical term.' },
  { id: 'TOPIC_UNITY', reason: 'Topic unity and topic-sentence adequacy require semantic review.' },
  { id: 'WARNING_CAUTION_CONTENT', reason: 'Risk level, placement, command adequacy, and consequences require structured metadata and human review.' },
];

export const RULES = [
  ['SENT20', 'warning'], ['SENT25', 'fail'], ['PARA6', 'fail'],
  ['SEMICOLON', 'fail'], ['CONTRACTION', 'fail'],
  ['PARENTHETICAL_PAREN', 'house-style'], ['PARENTHETICAL_DASH', 'house-style'],
  ['SLASHED', 'house-style'], ['PASSIVE', 'advisory'], ['INGFORM', 'advisory'],
  ['NOUNCLUSTER', 'advisory'], ['MULTICMD', 'advisory'],
];

const ABBREVIATIONS = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'sr.', 'jr.', 'no.', 'fig.', 'approx.', 'dept.', 'inc.', 'ltd.', 'st.']);
const BE = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being']);
const FUNCTION = new Set(`a an the this that these those i me my mine myself we us our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves who whom whose which what am is are was were be been being have has had having do does did doing can could may might must shall should will would and or nor but yet so for if then than because while when where after before as at by from in into of on onto over under through to up down with without about between among during against around near not no very also only each every some any all both either neither one two there here`.split(/\s+/));
const IRREGULAR_PARTICIPLES = new Set(`arisen awoken been begun bent bitten blown broken brought built bought caught chosen come cost cut dealt done drawn driven drunk eaten fallen fed felt fought found flown forgotten forgiven frozen given gone grown heard held hidden hit kept known laid led left lent lost made meant met paid put read ridden rung risen run said seen sent set shaken shown shut sung sat slept spoken spent stood stolen struck stuck swept swum taken taught torn told thought thrown understood worn won written`.split(/\s+/));
// These often denote an equipment state/property. Suppression lowers noise but can miss a true eventive passive.
const PASSIVE_ADJECTIVAL = new Set(['connected', 'installed', 'configured', 'calibrated', 'bounded', 'closed', 'open', 'required', 'ready', 'finished', 'located', 'related', 'based', 'interested', 'concerned']);
const AUX_FINITE = new Set([...BE, 'has', 'have', 'had', 'do', 'does', 'did', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would']);

function blankRange(chars, start, end) {
  for (let i = start; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

export function normalizeMarkdown(text) {
  // Use UTF-16 code units because RegExp indices and JSON offsets use JS string indices.
  const chars = text.split('');
  const stripped = [];
  // Fenced code, including an unterminated final fence.
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
  let open = null;
  for (const m of text.matchAll(fence)) {
    const marker = m[2][0];
    if (!open) open = { marker, size: m[2].length, start: m.index };
    else if (marker === open.marker && m[2].length >= open.size) {
      const end = m.index + m[0].length;
      blankRange(chars, open.start, end); stripped.push({ type: 'fenced-code', start: open.start, end }); open = null;
    }
  }
  if (open) { blankRange(chars, open.start, text.length); stripped.push({ type: 'fenced-code', start: open.start, end: text.length }); }

  // Markdown indented code and pasted machine blocks are not prose. Keep the
  // source length and offsets, but blank their content before block parsing.
  const literalLines = [
    ['indented-code', /^(?: {4,}(?![-+*]|\d+[.)]\s)\S).*$/gm],
    ['git-diff', /^(?:diff --git |@@ |--- |\+\+\+ ).*$/gm],
    ['log-line', /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b.*$/gm],
  ];
  for (const [type, re] of literalLines) for (const m of text.matchAll(re)) {
    const start = m.index, end = start + m[0].length;
    blankRange(chars, start, end); stripped.push({ type, start, end });
  }

  const alreadyBlank = (s, e) => chars.slice(s, e).every(c => /\s/.test(c));
  const patterns = [
    ['html-comment', /<!--[\s\S]*?-->/g],
    ['inline-code', /(`+)(?!`)([^\n]*?)\1/g],
    ['autolink', /<(?:https?:\/\/|mailto:)[^>\s]+>/gi],
    ['url', /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi],
  ];
  for (const [type, re] of patterns) {
    for (const m of text.matchAll(re)) {
      const start = m.index, end = start + m[0].length;
      if (alreadyBlank(start, end)) continue;
      blankRange(chars, start, end); stripped.push({ type, start, end });
    }
  }
  stripped.sort((a, b) => a.start - b.start);
  return { normalized: chars.join(''), stripped };
}

function classifyLine(raw) {
  if (/^\s*\|.*\|\s*$/.test(raw)) return ['table-row', raw.replace(/^\s*\|?|\|?\s*$/g, '')];
  if (/^\s{0,3}#{1,6}\s+/.test(raw)) return ['heading', raw.replace(/^\s{0,3}#{1,6}\s+/, '')];
  if (/^\s{0,3}>\s?/.test(raw)) return ['blockquote', raw.replace(/^\s{0,3}>\s?/, '')];
  if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(raw)) return ['list-item', raw.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')];
  return ['paragraph', raw.trim()];
}

export function makeBlocks(normalized) {
  const blocks = [];
  const lines = [];
  let pos = 0;
  for (const part of normalized.split(/(?<=\n)/)) {
    const body = part.replace(/[\r\n]+$/, '');
    lines.push({ body, start: pos }); pos += part.length;
  }
  if (!normalized.endsWith('\n') && lines.length === 0) lines.push({ body: normalized, start: 0 });
  let para = null;
  const flush = () => { if (para) { blocks.push(para); para = null; } };
  for (const line of lines) {
    if (!line.body.trim()) { flush(); continue; }
    const [type, content] = classifyLine(line.body);
    const local = line.body.indexOf(content);
    if (type === 'paragraph') {
      const trimmedStart = line.body.search(/\S/);
      const start = line.start + Math.max(0, trimmedStart);
      if (para) { para.text += ' ' + content; para.end = line.start + line.body.length; }
      else para = { type, text: content, start, end: line.start + line.body.length };
    } else {
      flush(); blocks.push({ type, text: content.trim(), start: line.start + Math.max(0, local), end: line.start + line.body.length });
    }
  }
  flush();
  return blocks.map((b, index) => ({ ...b, index }));
}

const MAX_ABBREVIATION_LENGTH = Math.max(...[...ABBREVIATIONS].map(x => x.length));
function periodIsInternal(text, i) {
  if (text[i] !== '.') return false;
  if (text[i - 1] === '.' || text[i + 1] === '.') return true;
  if (/\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) return true;

  // Inspect a fixed-size suffix. The old implementation sliced and rescanned
  // the full prefix at each period, which made segmentation quadratic.
  const suffix = text.slice(Math.max(0, i + 1 - MAX_ABBREVIATION_LENGTH), i + 1).toLowerCase();
  for (const abbreviation of ABBREVIATIONS) {
    if (suffix.endsWith(abbreviation)) {
      const before = text[i + 1 - abbreviation.length - 1];
      if (!before || !/[A-Za-z]/.test(before)) return true;
    }
  }
  // A final period in an initialism such as U.S. is internal. Four nearby
  // code units are enough to prove that shape, independent of prefix length.
  return /[A-Za-z]\.[A-Za-z]\.$/.test(text.slice(Math.max(0, i - 3), i + 1));
}

export function segmentSentences(text, base = 0) {
  const out = []; let start = 0;
  const push = end => {
    let a = start, b = end;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a < b && /[A-Za-z]/.test(text.slice(a, b))) out.push({ text: text.slice(a, b), start: base + a, end: base + b });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?]/.test(text[i])) continue;
    // Treat an ellipsis as one punctuation run, never as three empty sentences.
    if (text[i] === '.' && text[i + 1] === '.') {
      let end = i + 2;
      while (text[end] === '.') end++;
      while (end < text.length && /["'”’\])}]/.test(text[end])) end++;
      if (end === text.length || /\s/.test(text[end])) { push(end); i = end - 1; }
      continue;
    }
    if (text[i] === '.' && periodIsInternal(text, i)) continue;
    let end = i + 1;
    while (end < text.length && /[.!?]/.test(text[end])) end++;
    while (end < text.length && /["'”’\])}]/.test(text[end])) end++;
    if (end === text.length || /\s/.test(text[end])) { push(end); i = end - 1; }
  }
  if (start < text.length) push(text.length);
  return out;
}

export function wordTokens(text, base = 0) {
  const tokens = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*(?:-[\p{L}\p{N}]+(?:['’][\p{L}]+)*)*/gu;
  for (const m of text.matchAll(re)) if (/\p{L}/u.test(m[0])) tokens.push({ text: m[0], lower: m[0].toLowerCase().replace(/’/g, "'"), start: base + m.index, end: base + m.index + m[0].length });
  return tokens;
}

function excerpt(text, start, end) {
  return text.slice(Math.max(0, start - 28), Math.min(text.length, end + 28)).replace(/\s+/g, ' ').trim();
}
function finiteCandidate(s) {
  const words = wordTokens(s).map(t => t.lower);
  return words.some((w, i) => AUX_FINITE.has(w) || /(?:ed|es)$/.test(w) || (i > 0 && /s$/.test(w)));
}
function prose(type) { return type === 'paragraph' || type === 'list-item' || type === 'blockquote'; }

function excludedHeuristicRanges(text, base) {
  const ranges = [];
  const patterns = [
    /\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g,
    /\b(?:[A-Za-z0-9_-]+\.)+[A-Za-z]{1,8}\b/g,
    /\b[A-Za-z_]*_[A-Za-z0-9_-]+\b/g,
    /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,
    /“[^”\n]*—[^”\n]*”|"[^"\n]*—[^"\n]*"/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) ranges.push({ start: base + m.index, end: base + m.index + m[0].length });
  return ranges;
}
function withoutExcluded(tokens, ranges) {
  const kept = []; let rangeIndex = 0;
  for (const token of tokens) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= token.start) rangeIndex++;
    const range = ranges[rangeIndex];
    if (!range || token.end <= range.start) kept.push(token);
  }
  return kept;
}
function quotedDashRange(text, start, end) {
  for (const re of [/“[^”\n]*—[^”\n]*”/g, /"[^"\n]*—[^"\n]*"/g]) for (const m of text.matchAll(re)) if (m.index <= start && m.index + m[0].length >= end) return true;
  return false;
}

export function checkRecord(record, ordinal = 0, options = {}) {
  const source = String(record.text ?? '');
  if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) throw new Error(`Text exceeds the ${MAX_INPUT_BYTES}-byte limit`);
  const id = record.id ?? `${record.session ?? 'record'}:${record.line ?? ordinal + 1}`;
  const { normalized, stripped } = normalizeMarkdown(source);
  const blocks = makeBlocks(normalized);
  const findings = []; let sentenceCount = 0, totalWords = 0, omittedFindings = 0;
  const maxFindings = Math.max(0, Math.min(MAX_FINDINGS, Number.isSafeInteger(options.maxFindings) ? options.maxFindings : MAX_FINDINGS));
  const add = (rule, cls, block, sentence, start, end) => {
    if (findings.length >= maxFindings) { omittedFindings++; return; }
    findings.push({ id: rule, class: cls, block: block.index, sentence, offset: { start, end }, excerpt: excerpt(source, start, end) });
  };

  for (const block of blocks) {
    block.sentences = segmentSentences(block.text, block.start);
    block.words = wordTokens(block.text, block.start).length;
    if (!prose(block.type)) continue;
    sentenceCount += block.sentences.length; totalWords += block.words;
    if (block.type === 'paragraph' && block.sentences.length > 6) add('PARA6', 'fail', block, null, block.start, block.end);

    const scans = [
      ['SEMICOLON', /;/g],
      ['CONTRACTION', /\b(?:i|you|we|they|he|she|it|that|there|here|what|who|how|where|when|why|let)(?:n['’]t|['’](?:re|ll|ve|d|m|s))\b|\b(?:is|are|was|were|do|does|did|has|have|had|can|could|should|would|will|must|might|need|dare|wo|sha)n['’]t\b/gi],
    ];
    for (const [rule, re] of scans) for (const m of block.text.matchAll(re)) add(rule, 'fail', block, null, block.start + m.index, block.start + m.index + m[0].length);
    for (const m of block.text.matchAll(/(?<!\/)\b[\p{L}]+\/[\p{L}]+\b(?!\/)/gu)) add('SLASHED', 'house-style', block, null, block.start + m.index, block.start + m.index + m[0].length);

    for (const m of block.text.matchAll(/\(([^()]*)\)/g)) if (finiteCandidate(m[1])) add('PARENTHETICAL_PAREN', 'house-style', block, null, block.start + m.index, block.start + m.index + m[0].length);
    for (const m of block.text.matchAll(/(?:—|\s–\s)([^—–\n]+?)(?:—|\s–\s)/g)) {
      if (!quotedDashRange(block.text, m.index, m.index + m[0].length)) add('PARENTHETICAL_DASH', 'house-style', block, null, block.start + m.index, block.start + m.index + m[0].length);
    }

    block.sentences.forEach((sentence, si) => {
      const tokens = wordTokens(sentence.text, sentence.start);
      const excluded = excludedHeuristicRanges(sentence.text, sentence.start).sort((a, b) => a.start - b.start || a.end - b.end);
      const heuristicTokens = withoutExcluded(tokens, excluded);
      // Emit one length result: 21–25 words warns; more than 25 fails.
      if (tokens.length > 25) add('SENT25', 'fail', block, si, sentence.start, sentence.end);
      else if (tokens.length > 20) add('SENT20', 'warning', block, si, sentence.start, sentence.end);

      for (let i = 0; i < heuristicTokens.length - 1; i++) {
        if (!BE.has(heuristicTokens[i].lower)) continue;
        let j = i + 1;
        if (j < heuristicTokens.length && /ly$/.test(heuristicTokens[j].lower)) j++;
        const p = heuristicTokens[j]?.lower;
        if (p && ((/ed$/.test(p) && !PASSIVE_ADJECTIVAL.has(p)) || IRREGULAR_PARTICIPLES.has(p))) add('PASSIVE', 'advisory', block, si, heuristicTokens[i].start, heuristicTokens[j].end);
      }
      heuristicTokens.forEach((t, i) => {
        if (!/ing$/.test(t.lower) || BE.has(heuristicTokens[i - 1]?.lower)) return;
        if (i === 0 && heuristicTokens.length > 1) return; // likely a heading-like/gerund-subject noun; intentionally conservative
        add('INGFORM', 'advisory', block, si, t.start, t.end);
      });

      let run = [];
      const flushRun = () => { if (run.length >= 4) add('NOUNCLUSTER', 'advisory', block, si, run[0].start, run.at(-1).end); run = []; };
      for (const t of heuristicTokens) { if (FUNCTION.has(t.lower)) flushRun(); else run.push(t); } flushRun();

      let commandRangeIndex = 0;
      for (const m of sentence.text.matchAll(/(?:,\s*then\s+|\band\s+then\s+|\band\s+)([A-Za-z][A-Za-z'-]*)/gi)) {
        const first = heuristicTokens[0]?.lower;
        const second = m[1].toLowerCase();
        const matchStart = sentence.start + m.index, matchEnd = matchStart + m[0].length;
        while (commandRangeIndex < excluded.length && excluded[commandRangeIndex].end < matchStart) commandRangeIndex++;
        const range = excluded[commandRangeIndex];
        const excludedMatch = range && range.start <= matchStart && range.end >= matchEnd;
        if (first && !FUNCTION.has(first) && !FUNCTION.has(second) && !excludedMatch) add('MULTICMD', 'advisory', block, si, matchStart, matchEnd);
      }
    });
  }
  // Headings and tables remain visible as blocks but do not contribute to prose statistics.
  return {
    id, blocks: blocks.length, sentences: sentenceCount, words: totalWords,
    blockDetails: blocks.map(({ index, type, start, end, words, sentences }) => ({ index, type, start, end, words: words ?? wordTokens(blocks[index].text).length, sentences: sentences?.length ?? segmentSentences(blocks[index].text).length })),
    stripped, findings, findingsTruncated: omittedFindings > 0, omittedFindings,
  };
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function distribution(values) {
  const a = [...values].sort((x, y) => x - y);
  const sum = a.reduce((x, y) => x + y, 0);
  return { count: a.length, mean: a.length ? sum / a.length : 0, median: quantile(a, .5), p90: quantile(a, .9), p95: quantile(a, .95), max: a.at(-1) ?? 0 };
}
export function aggregate(checked, originalRecords = []) {
  const totalWords = checked.reduce((n, r) => n + r.words, 0);
  const rules = {};
  for (const [id, cls] of RULES) {
    const counts = checked.map(r => r.findings.filter(f => f.id === id).length);
    const count = counts.reduce((a, b) => a + b, 0);
    rules[id] = { class: cls, findings: count, records: counts.filter(Boolean).length, ratePer1000Words: totalWords ? count * 1000 / totalWords : 0 };
  }
  const sentenceLengths = [], paragraphSentences = [];
  originalRecords.forEach(r => {
    const { normalized } = normalizeMarkdown(String(r.text ?? ''));
    for (const b of makeBlocks(normalized)) if (prose(b.type)) {
      const ss = segmentSentences(b.text);
      ss.forEach(s => sentenceLengths.push(wordTokens(s.text).length));
      if (b.type === 'paragraph') paragraphSentences.push(ss.length);
    }
  });
  const classCount = cls => checked.reduce((n, r) => n + r.findings.filter(f => f.class === cls).length, 0);
  return {
    records: checked.length, words: totalWords,
    failFindings: classCount('fail'), warningFindings: classCount('warning'),
    houseStyleFindings: classCount('house-style'), advisoryFindings: classCount('advisory'),
    findingsTruncated: checked.some(r => r.findingsTruncated),
    omittedFindings: checked.reduce((n, r) => n + r.omittedFindings, 0),
    rules, sentenceLength: distribution(sentenceLengths), wordsPerRecord: distribution(checked.map(r => r.words)),
    sentencesPerParagraph: distribution(paragraphSentences), notChecked: NOT_CHECKED,
  };
}

export function checkText(text, options = {}) {
  return checkRecord({ id: options.id ?? 'text', text }, 0, options);
}

export function run(records, options = {}) {
  if (records.length > MAX_RECORDS) throw new Error(`Input exceeds the ${MAX_RECORDS}-record limit`);
  const bytes = records.reduce((total, record) => total + Buffer.byteLength(String(record.text ?? ''), 'utf8'), 0);
  if (bytes > MAX_INPUT_BYTES) throw new Error(`Records exceed the ${MAX_INPUT_BYTES}-byte total limit`);
  const limit = Math.max(0, Math.min(MAX_FINDINGS, Number.isSafeInteger(options.maxFindings) ? options.maxFindings : MAX_FINDINGS));
  let remaining = limit;
  const checked = records.map((record, ordinal) => {
    const result = checkRecord(record, ordinal, { maxFindings: remaining });
    remaining -= result.findings.length;
    return result;
  });
  return { records: checked, aggregate: aggregate(checked, records) };
}

export function formatText(result) {
  const a = result.aggregate;
  const lines = [`Writing check: ${a.records} records, ${a.words} prose words, ${a.failFindings} fail, ${a.warningFindings} warning, ${a.houseStyleFindings} house-style, ${a.advisoryFindings} advisory findings`];
  for (const [id, x] of Object.entries(a.rules)) lines.push(`${id} [${x.class}]: ${x.findings} findings in ${x.records} records (${x.ratePer1000Words.toFixed(2)}/1000 words)`);
  lines.push(`Sentence words: mean ${a.sentenceLength.mean.toFixed(2)}, median ${a.sentenceLength.median.toFixed(2)}, p90 ${a.sentenceLength.p90.toFixed(2)}, p95 ${a.sentenceLength.p95.toFixed(2)}, max ${a.sentenceLength.max}`);
  lines.push(`Words/record: mean ${a.wordsPerRecord.mean.toFixed(2)}, median ${a.wordsPerRecord.median.toFixed(2)}, p90 ${a.wordsPerRecord.p90.toFixed(2)}, p95 ${a.wordsPerRecord.p95.toFixed(2)}, max ${a.wordsPerRecord.max}`);
  lines.push(`Sentences/paragraph: mean ${a.sentencesPerParagraph.mean.toFixed(2)}, median ${a.sentencesPerParagraph.median.toFixed(2)}, p90 ${a.sentencesPerParagraph.p90.toFixed(2)}, p95 ${a.sentencesPerParagraph.p95.toFixed(2)}, max ${a.sentencesPerParagraph.max}`);
  if (a.findingsTruncated) lines.push(`FINDINGS CAPPED: ${a.omittedFindings} additional findings omitted after the ${MAX_FINDINGS}-finding limit.`);
  lines.push('NOT CHECKED:');
  for (const x of a.notChecked) lines.push(`- ${x.id}: ${x.reason}`);
  for (const r of result.records) for (const f of r.findings) lines.push(`${r.id} b${f.block} s${f.sentence ?? '-'} ${f.id} [${f.class}] ${f.offset.start}-${f.offset.end}: ${f.excerpt}`);
  return lines.join('\n');
}

function readRegularFile(path, budget) {
  let lst;
  try { lst = fs.lstatSync(path); }
  catch (error) { throw new Error(`Cannot inspect ${path}: ${error.message}`); }
  if (!lst.isFile()) throw new Error(`Refused ${path}: input must be a regular file (no symlinks or special files)`);
  if (lst.size > budget) throw new Error(`Refused ${path}: input exceeds the ${MAX_INPUT_BYTES}-byte total limit`);

  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('opened input is not a regular file');
    if (stat.size > budget) throw new Error(`input exceeds the ${MAX_INPUT_BYTES}-byte total limit`);
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > stat.size) throw new Error('input changed while it was read');
    return { text: buffer.subarray(0, used).toString('utf8'), bytes: used };
  } catch (error) {
    throw new Error(`Refused ${path}: ${error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function parseJsonl(text) {
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record must be an object');
      records.push(value);
      if (records.length > MAX_RECORDS) throw new Error(`record count exceeds the ${MAX_RECORDS}-record limit`);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  }
  return records;
}

export function recordsFromFiles(files) {
  if (files.length > MAX_RECORDS) throw new Error(`Input exceeds the ${MAX_RECORDS}-record limit`);
  let budget = MAX_INPUT_BYTES;
  return files.map(path => {
    const loaded = readRegularFile(path, budget);
    budget -= loaded.bytes;
    return { id: path, path, text: loaded.text };
  });
}

export function recordsFromUnifiedDiff(text, id = 'diff') {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error(`Diff exceeds the ${MAX_INPUT_BYTES}-byte limit`);
  const records = [];
  let file = id, newLine = 0, runStart = 0, run = [], inHunk = false;
  const flush = () => {
    if (run.length) {
      if (records.length >= MAX_RECORDS) throw new Error(`Diff exceeds the ${MAX_RECORDS}-record limit`);
      records.push({ id: `${file}:${runStart}`, path: file, addedLine: runStart, text: run.join('\n') });
    }
    run = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!inHunk && raw.startsWith('+++ ')) {
      flush();
      const label = raw.slice(4).split(/\t/)[0];
      file = label.startsWith('b/') ? label.slice(2) : label;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { flush(); newLine = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (raw.startsWith('+')) {
      if (!run.length) runStart = newLine;
      run.push(raw.slice(1)); newLine++; continue;
    }
    flush();
    if (raw.startsWith(' ')) newLine++;
    else if (raw.startsWith('\\ No newline at end of file')) continue;
    else if (!raw.startsWith('-')) inHunk = false;
  }
  flush();
  return records;
}

function usage() {
  return `Usage:\n  node writing-check.mjs --input records.jsonl [--format json|text]\n  node writing-check.mjs --file PATH [--file PATH ...] [--format json|text]\n  node writing-check.mjs --diff changes.diff [--format json|text]\n\n--diff accepts a unified-diff file and checks only added lines. Inputs must be regular files. The combined byte limit is ${MAX_INPUT_BYTES}, the record limit is ${MAX_RECORDS}, and output is capped at ${MAX_FINDINGS} findings.`;
}

function cli() {
  const args = process.argv.slice(2); let input = null, diff = null, format = 'json'; const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) input = args[++i];
    else if (args[i] === '--file' && args[i + 1]) files.push(args[++i]);
    else if (args[i] === '--diff' && args[i + 1]) diff = args[++i];
    else if (args[i] === '--format' && /^(json|text)$/.test(args[i + 1] || '')) format = args[++i];
    else if (args[i] === '--help') { console.log(usage()); return; }
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const modes = Number(input !== null) + Number(diff !== null) + Number(files.length > 0);
  if (modes !== 1) throw new Error('Select exactly one input mode: --input, --file, or --diff');

  let records;
  if (files.length) records = recordsFromFiles(files);
  else {
    const path = input ?? diff;
    const loaded = readRegularFile(path, MAX_INPUT_BYTES);
    records = input ? parseJsonl(loaded.text) : recordsFromUnifiedDiff(loaded.text, basename(path));
  }
  const result = run(records);
  process.stdout.write(format === 'json' ? JSON.stringify(result, null, 2) + '\n' : formatText(result) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { cli(); }
  catch (error) { console.error(`writing-check: ${error.message}`); process.exitCode = 1; }
}
