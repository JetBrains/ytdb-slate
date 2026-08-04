#!/usr/bin/env node
/**
 * Dictionary-free STE proxy. This reports surface facts and noisy advisories;
 * it does not establish ASD-STE100 conformance and embeds no controlled vocabulary.
 */
import fs from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_RECORDS = 10000;
/** Per-record cap. One noisy record must not consume another record's budget. */
export const MAX_FINDINGS = 1000;
/**
 * FX3. A per-record cap alone bounds nothing: 8000 cap-legal records of 90
 * findings each produced 210 MB of stdout and 1.2 GB of RSS, because the bound
 * was 1000 findings times the record count. This bounds a whole run too, and
 * the two bounds combine as an EQUAL per-record allowance rather than as a
 * first-come budget, because a first-come budget is what BG6 rejected.
 *
 * Two facts set the value. It must be at least MAX_RECORDS, or the one-finding
 * visibility floor below would exceed it and the budget would be a false claim.
 * At 20x the per-record cap it also leaves every record of a 19-file run at the
 * full per-record cap, which is this repository's own documentation set, so the
 * budget binds on amplification rather than on ordinary use.
 */
export const MAX_TOTAL_FINDINGS = 20000;
/** Includes the two reserved framing characters. */
export const MAX_EXCERPT_CHARS = 2000;
// SC7: findings were capped but these two arrays were not, so a 1 MiB input
// produced 62 MB of stdout. Both bounds sit far above real documents (the
// largest file in this repository reports 591 blocks and 1229 stripped spans),
// so they truncate only pathological input.
export const MAX_STRIPPED = 5000;
export const MAX_BLOCK_DETAILS = 5000;

// SC6: O_NOFOLLOW closes the symlink path but not the lstat→open race. If a
// regular file is replaced by a FIFO in that window, a blocking O_RDONLY open
// waits forever for a writer and fstat is never reached. O_NONBLOCK makes the
// open return; fstat below then rejects the swapped non-regular descriptor.
// It has no effect on ordinary regular-file reads.
export const REGULAR_FILE_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

const EXCERPT_OPEN = '⟦';
const EXCERPT_CLOSE = '⟧';
// Same categories as mode.ts cell(): controls (including ESC, BEL and BS),
// format characters (including bidi overrides), Unicode line/paragraph
// separators, and lone surrogates. The modules must stay independent: this is a
// plain Node command and importing mode.ts would pull the pi SDK and TypeScript
// into it. The shared INTENT is kept explicit here instead.
const REPORT_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]+/gu;

function visibleReportText(value) {
  let text;
  try { text = String(value); } catch { text = '(unprintable)'; }
  return text.replace(REPORT_UNSAFE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * SC4. Finding lines begin with the record id, so an id containing a newline
 * could create a fake `ALL_CLEAR`, summary, rule or NOT CHECKED line. Keep safe
 * ids byte-identical (so ordinary reports do not churn); encode every unsafe
 * code point for the rest. A literal ALL_CLEAR is reserved too, even without a
 * newline, because it would otherwise occupy the structural first column.
 */
export function sanitizeReportId(value) {
  const visible = visibleReportText(value);
  const safe = visible.replace(/[^A-Za-z0-9._/@:+-]/g, (c) => `%${c.codePointAt(0).toString(16).toUpperCase()}`);
  return /^(?:ALL_CLEAR|Writing|NOT|FINDINGS|STE)$/i.test(safe) ? `%${safe}` : (safe || '(unnamed)');
}

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

export function makeAbbreviationSet(values) {
  for (const value of values) {
    if (value !== value.toLowerCase()) throw new Error(`Abbreviations must be lowercase: ${value}`);
  }
  return new Set(values);
}
// periodIsInternal lowercases its search window. Enforce the matching table's
// lowercase-only invariant at construction instead of leaving mixed-case values
// silently unreachable.
const ABBREVIATIONS = makeAbbreviationSet(['e.g.', 'i.e.', 'etc.', 'vs.', 'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'sr.', 'jr.', 'no.', 'fig.', 'approx.', 'dept.', 'inc.', 'ltd.', 'st.']);
const BE = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being']);
const FUNCTION = new Set(`a an the this that these those i me my mine myself we us our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves who whom whose which what am is are was were be been being have has had having do does did doing can could may might must shall should will would and or nor but yet so for if then than because while when where after before as at by from in into of on onto over under through to up down with without about between among during against around near not no very also only each every some any all both either neither one two there here`.split(/\s+/));
const IRREGULAR_PARTICIPLES = new Set(`arisen awoken been begun bent bitten blown broken brought built bought caught chosen come cost cut dealt done drawn driven drunk eaten fallen fed felt fought found flown forgotten forgiven frozen given gone grown heard held hidden hit kept known laid led left lent lost made meant met paid put read ridden rung risen run said seen sent set shaken shown shut sung sat slept spoken spent stood stolen struck stuck swept swum taken taught torn told thought thrown understood worn won written`.split(/\s+/));
// These often denote an equipment state/property. Suppression lowers noise but can miss a true eventive passive.
const PASSIVE_ADJECTIVAL = new Set(['connected', 'installed', 'configured', 'calibrated', 'bounded', 'closed', 'open', 'required', 'ready', 'finished', 'located', 'related', 'based', 'interested', 'concerned']);
const AUX_FINITE = new Set([...BE, 'has', 'have', 'had', 'do', 'does', 'did', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would']);

function blankRange(chars, start, end) {
  for (let i = start; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

// ------------------------------------------------------------- scanners ----
// Five patterns in this module were quadratic: each restarted a forward scan at
// every candidate position, so one failed attempt was repeated for every
// character before it. At the module's own 1 MiB input cap that cost minutes
// (SC1, SC2), and the checker runs inside a turn hook.
//
// Each is replaced below by a scanner that visits the input a bounded number of
// times. Every scanner reproduces its regex's match list EXACTLY, including
// leftmost-first order and the resume point after a match; the equivalence is
// pinned by fixtures in verification/writing-check-tests.mjs and the growth is
// gated by verification/writing-check-scaling.mjs.

/**
 * `<!--[\s\S]*?-->`. The closer is the first `-->` at or after the opener, so
 * indexOf finds it directly. An opener with no closer after it means no LATER
 * opener has one either, which is what makes the failing case linear instead of
 * a rescan per opener.
 */
export function scanHtmlComments(text) {
  const out = [];
  for (let from = 0; ; ) {
    const open = text.indexOf('<!--', from);
    if (open < 0) break;
    const close = text.indexOf('-->', open + 4);
    if (close < 0) break;
    out.push({ start: open, end: close + 3 });
    from = close + 3;
  }
  return out;
}

const AUTOLINK_OPEN = /<(?:https?:\/\/|mailto:)/gi;
const AUTOLINK_RUN = /[^>\s]*/y;
/**
 * `<(?:https?://|mailto:)[^>\s]+>`. The run excludes `>`, so only the maximal
 * run can be followed by one and there is exactly one candidate end per opener.
 * `guard` is the terminator cursor: terminators are non-decreasing in the start
 * position, so it never moves backwards and the whole scan reads each character
 * once.
 */
export function scanAutolinks(text) {
  const out = [];
  let guard = 0;
  let lastEnd = 0;
  AUTOLINK_OPEN.lastIndex = 0;
  for (let m = AUTOLINK_OPEN.exec(text); m; m = AUTOLINK_OPEN.exec(text)) {
    if (m.index < lastEnd) continue;
    const runStart = m.index + m[0].length;
    AUTOLINK_RUN.lastIndex = Math.max(guard, runStart);
    AUTOLINK_RUN.exec(text);
    const stop = AUTOLINK_RUN.lastIndex;
    guard = stop;
    if (stop > runStart && text[stop] === '>') {
      out.push({ start: m.index, end: stop + 1 });
      lastEnd = stop + 1;
    }
  }
  return out;
}

const TICK_RUN = /`+/g;
/**
 * `` (`+)(?!`)([^\n]*?)\1 ``. The negative lookahead forces the opening group to
 * run to the end of its backtick run, so every candidate opener is a suffix of
 * one run and the candidates are enumerable from the runs alone. For an opener
 * of K backticks the lazy body takes the EARLIEST later run of at least K
 * backticks, on the same line.
 *
 * The per-line suffix maximum is what keeps this linear: it answers "is any
 * later run long enough" without walking, and the walk that follows is paid for
 * by the text the match then consumes.
 */
export function scanInlineCode(text) {
  const runs = [];
  TICK_RUN.lastIndex = 0;
  for (let m = TICK_RUN.exec(text); m; m = TICK_RUN.exec(text)) {
    runs.push({ start: m.index, end: m.index + m[0].length });
  }
  if (runs.length === 0) return [];
  // lineEnd[i] — the newline that bounds run i's body, since the body cannot
  // cross one. sufMax[i] — the longest run from i to the end of run i's line.
  const sufMax = new Int32Array(runs.length + 1);
  const lineEnd = new Int32Array(runs.length);
  // Forward pass with a cursor that only advances. Calling indexOf per run
  // instead re-scans the tail for every run, which is the very shape being
  // removed here: with no newline in the input that is quadratic again.
  let newline = text.indexOf('\n');
  for (let i = 0; i < runs.length; i++) {
    while (newline >= 0 && newline < runs[i].end) newline = text.indexOf('\n', newline + 1);
    lineEnd[i] = newline < 0 ? text.length : newline;
  }
  for (let i = runs.length - 1; i >= 0; i--) {
    const sameLine = i + 1 < runs.length && runs[i + 1].start < lineEnd[i];
    sufMax[i] = Math.max(runs[i].end - runs[i].start, sameLine ? sufMax[i + 1] : 0);
  }
  const out = [];
  let lastEnd = 0;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].end <= lastEnd) continue;
    // A match may resume mid-run, so the opener starts at the later of the run
    // start and the previous match's end.
    const from = Math.max(runs[i].start, lastEnd);
    const bound = lineEnd[i];
    const reach = i + 1 < runs.length && runs[i + 1].start < bound ? sufMax[i + 1] : 0;
    // Openers are tried longest first (leftmost start wins), and an opener of K
    // needs a later run of at least K, so the longest workable opener is K*.
    const kStar = Math.min(runs[i].end - from, reach);
    if (kStar < 1) continue;
    let partner = -1;
    for (let j = i + 1; j < runs.length && runs[j].start < bound; j++) {
      if (runs[j].end - runs[j].start >= kStar) { partner = j; break; }
    }
    if (partner < 0) continue;
    const openerStart = runs[i].end - kStar;
    const end = runs[partner].start + kStar;
    out.push({ start: openerStart, end });
    lastEnd = end;
    // Resume inside the partner run when it had backticks to spare.
    if (end < runs[partner].end) i = partner - 1;
    else i = partner;
  }
  return out;
}

const LOG_LINE_CORE = /^[^\S\n]*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b.*$/gm;
const WHITESPACE = /\s/;
/**
 * The log-line pattern opened with `^\s*`, and `\s` matches a newline, so at
 * every line start the scan ran to the end of the whitespace and backtracked
 * over all of it. The anchor here is horizontal-only, which is linear; the
 * start is then extended back over the same whitespace the original consumed,
 * so the reported span is unchanged. The walk stops at the previous match's
 * end, because the original could not start before it either.
 */
function isJsLineTerminator(char) {
  return char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
}

export function scanLogLines(text) {
  const out = [];
  let lastEnd = 0;
  LOG_LINE_CORE.lastIndex = 0;
  for (let m = LOG_LINE_CORE.exec(text); m; m = LOG_LINE_CORE.exec(text)) {
    if (m.index < lastEnd) continue;
    let p = m.index;
    while (p > lastEnd && WHITESPACE.test(text[p - 1])) p--;
    let start = p;
    if (p !== 0) {
      // JavaScript's multiline `^` recognizes FOUR line terminators: LF, CR,
      // U+2028 and U+2029. The old /^\s*.../gm match starts after the FIRST
      // such terminator in this whitespace run, then \s* consumes the rest.
      // Looking only for LF changed exported spans on CRLF/Unicode input and
      // left tabs/NBSP unblanked. This forward walk and the backward walk above
      // visit a whitespace run at most twice; lastEnd prevents a later match
      // from visiting that run again.
      start = m.index;
      for (let i = p; i < m.index; i++) {
        if (isJsLineTerminator(text[i])) { start = i + 1; break; }
      }
    }
    const end = m.index + m[0].length;
    out.push({ start, end });
    lastEnd = end;
    if (LOG_LINE_CORE.lastIndex === m.index) LOG_LINE_CORE.lastIndex++;
  }
  return out;
}

const PATH_SEGMENT = /[A-Za-z0-9_.-]+/g;
/**
 * `\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+`. On a long run with no slash the
 * first group matched to the end and then backtracked over every length looking
 * for one, at every start position (SC2 — a single call, not a rescan).
 *
 * A match is just a maximal chain of segments joined by single slashes, plus a
 * leading slash when one is there, so listing the segments once decides every
 * match. A chain of one segment is not a match, which is why `a//b` yields
 * nothing and `a//b/c` yields only `/b/c`.
 */
export function scanPathTokens(text) {
  const segments = [];
  PATH_SEGMENT.lastIndex = 0;
  for (let m = PATH_SEGMENT.exec(text); m; m = PATH_SEGMENT.exec(text)) {
    segments.push({ start: m.index, end: m.index + m[0].length });
  }
  const out = [];
  for (let i = 0; i < segments.length; ) {
    let j = i;
    while (j + 1 < segments.length && segments[j + 1].start === segments[j].end + 1 && text[segments[j].end] === '/') j++;
    if (j > i) {
      const head = segments[i].start;
      out.push({ start: head > 0 && text[head - 1] === '/' ? head - 1 : head, end: segments[j].end });
    }
    i = j + 1;
  }
  return out;
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
  const spansOf = (re) => {
    const out = [];
    for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  };
  const literalLines = [
    ['indented-code', spansOf(/^(?: {4,}(?![-+*]|\d+[.)]\s)\S).*$/gm)],
    ['git-diff', spansOf(/^(?:diff --git |@@ |--- |\+\+\+ ).*$/gm)],
    ['log-line', scanLogLines(text)],
  ];
  for (const [type, spans] of literalLines) for (const { start, end } of spans) {
    blankRange(chars, start, end); stripped.push({ type, start, end });
  }

  // No slice: the old copy allocated a fresh array per match, and one match can
  // span the whole input.
  const alreadyBlank = (s, e) => {
    for (let i = s; i < e; i++) if (!WHITESPACE.test(chars[i])) return false;
    return true;
  };
  const patterns = [
    ['html-comment', scanHtmlComments(text)],
    ['inline-code', scanInlineCode(text)],
    ['autolink', scanAutolinks(text)],
    // A trailing `. , ; : ! ?` is sentence punctuation, not URL data. The same
    // characters remain part of a URL when another URL character follows them,
    // so dotted paths and query punctuation still work. A literal terminal
    // punctuation character must be percent-encoded to remove the ambiguity.
    ['url', spansOf(/\b(?:https?:\/\/|www\.)[^\s<>()]*[^\s<>().,;:!?]/gi)],
  ];
  for (const [type, spans] of patterns) {
    for (const { start, end } of spans) {
      if (alreadyBlank(start, end)) continue;
      blankRange(chars, start, end); stripped.push({ type, start, end });
    }
  }
  stripped.sort((a, b) => a.start - b.start);
  // SC7: blanking above is complete; only the REPORTED list is bounded.
  const omittedStripped = Math.max(0, stripped.length - MAX_STRIPPED);
  return {
    normalized: chars.join(''),
    stripped: omittedStripped > 0 ? stripped.slice(0, MAX_STRIPPED) : stripped,
    strippedTruncated: omittedStripped > 0,
    omittedStripped,
  };
}

/**
 * [type, content, offset] — `offset` is where `content` begins inside `raw`.
 *
 * The offset is taken from the length of the prefix the classifier strips, not
 * from indexOf(content) as it once was. indexOf can find an EARLIER copy of the
 * content and report a position the text is not at: `> > x` strips to `> x`,
 * which indexOf then locates at 0 rather than at 2 (BG2, same class as the
 * paragraph join). A strip length cannot be wrong that way.
 */
function classifyLine(raw) {
  if (/^\s*\|.*\|\s*$/.test(raw)) {
    return ['table-row', raw.replace(/^\s*\|?|\|?\s*$/g, ''), raw.match(/^\s*\|?/)[0].length];
  }
  const heading = raw.match(/^\s{0,3}#{1,6}\s+/);
  if (heading) return ['heading', raw.slice(heading[0].length), heading[0].length];
  const quote = raw.match(/^\s{0,3}>\s?/);
  if (quote) return ['blockquote', raw.slice(quote[0].length), quote[0].length];
  const item = raw.match(/^\s*(?:[-+*]|\d+[.)])\s+/);
  if (item) return ['list-item', raw.slice(item[0].length), item[0].length];
  return ['paragraph', raw.trim(), raw.length - raw.trimStart().length];
}

/**
 * BG2. A paragraph's block text is its lines TRIMMED and joined with a single
 * space, so it is not a verbatim slice of the source: past the first line every
 * position in it is displaced by the indent, the trailing spaces and the newline
 * the join removed. Every rule reported `block.start + indexInBlockText`, so
 * every offset on a multi-line paragraph pointed at the wrong character — 303 of
 * the 1035 shape-checkable findings over this repository's own Markdown.
 *
 * The text itself is deliberately UNCHANGED. Rules must keep matching what they
 * match today: a sentence split across two source lines has to segment as one
 * sentence, and a rule whose pattern spans the line break has to keep firing. So
 * the join stays and the block carries a MAP instead.
 *
 * `segments` lists the verbatim runs: block.text.slice(text, text + length) is
 * exactly normalized.slice(source, source + length). The gaps between segments
 * are the injected join spaces, which stand for source whitespace rather than
 * copying it. A block whose text IS a verbatim slice carries no segments at all
 * and maps by addition — that is every heading, list item, table row and
 * single-line paragraph, so the common case allocates nothing.
 */
export function makeBlocks(normalized) {
  const blocks = [];
  const lines = [];
  let pos = 0;
  for (const part of normalized.split(/(?<=\n)/)) {
    const body = part.replace(/[\r\n]+$/, '');
    lines.push({ body, start: pos }); pos += part.length;
  }
  let para = null;
  const flush = () => { if (para) { if (para.segments.length < 2) delete para.segments; blocks.push(para); para = null; } };
  for (const line of lines) {
    if (!line.body.trim()) { flush(); continue; }
    const [type, content, offset] = classifyLine(line.body);
    if (type === 'paragraph') {
      const start = line.start + offset;
      if (para) {
        // The injected space sits at para.text.length; the line follows it.
        para.segments.push({ text: para.text.length + 1, source: start, length: content.length });
        para.text += ' ' + content;
        para.end = line.start + line.body.length;
      } else {
        para = { type, text: content, start, end: line.start + line.body.length, segments: [{ text: 0, source: start, length: content.length }] };
      }
    } else {
      flush();
      // These are trimmed a SECOND time, so the kept run can start after the
      // stripped marker. `start` counts that too; it used to point at the
      // whitespace instead.
      const trimmed = content.trim();
      const lead = content.length - content.trimStart().length;
      blocks.push({ type, text: trimmed, start: line.start + offset + lead, end: line.start + line.body.length });
    }
  }
  flush();
  return blocks.map((b, index) => ({ ...b, index }));
}

/**
 * One position in a block's text, as a source offset. Used for both ends of a
 * range: an exclusive end maps by the same rule, so a range that crosses a join
 * correctly covers the source newline between the two lines.
 *
 * An index that lands ON an injected space maps to the first source character
 * the join replaced, which is where the whitespace run actually begins.
 */
export function blockOffset(block, index) {
  const segments = block.segments;
  if (segments === undefined) return block.start + index;
  let lo = 0, hi = segments.length - 1, before = segments[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (index < seg.text) hi = mid - 1;
    else if (index >= seg.text + seg.length) { before = seg; lo = mid + 1; }
    else return seg.source + (index - seg.text);
  }
  return before.source + before.length;
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

export function excerpt(text, start, end) {
  // SC5: strip the same Unicode safety categories as doctrine table cells.
  // SC9: reserve and add the delimiters in BOTH JSON and text output. Removing
  // delimiter characters from source prose means the first ⟦ and final ⟧ are
  // unambiguously framing, never attacker content.
  let content = visibleReportText(text.slice(Math.max(0, start - 28), Math.min(text.length, end + 28)))
    .replace(/[⟦⟧]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // The 2000-character limit INCLUDES the frame. Keep both ends so whole-unit
  // findings (SENT20, SENT25 and PARA6) retain their opening and conclusion.
  // Avoid cutting a valid surrogate pair; that can make the result shorter than
  // the cap by one code unit but never longer.
  const marker = ' … [middle elided] … ';
  const contentLimit = MAX_EXCERPT_CHARS - EXCERPT_OPEN.length - EXCERPT_CLOSE.length;
  if (content.length > contentLimit) {
    const kept = contentLimit - marker.length;
    let headEnd = Math.ceil(kept / 2);
    let tailStart = content.length - Math.floor(kept / 2);
    if (headEnd > 0 && /[\uD800-\uDBFF]/.test(content[headEnd - 1])) headEnd--;
    if (tailStart < content.length && /[\uDC00-\uDFFF]/.test(content[tailStart])) tailStart++;
    content = content.slice(0, headEnd) + marker + content.slice(tailStart);
  }
  return `${EXCERPT_OPEN}${content}${EXCERPT_CLOSE}`;
}
function finiteCandidate(s) {
  const words = wordTokens(s).map(t => t.lower);
  return words.some((w, i) => AUX_FINITE.has(w) || /(?:ed|es)$/.test(w) || (i > 0 && /s$/.test(w)));
}
function prose(type) { return type === 'paragraph' || type === 'list-item' || type === 'blockquote'; }

function excludedHeuristicRanges(text, base) {
  const ranges = [];
  // The path pattern is scanned, not matched: see scanPathTokens (SC2).
  for (const span of scanPathTokens(text)) ranges.push({ start: base + span.start, end: base + span.end });
  const patterns = [
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
/**
 * BG1/PF1: this used to re-scan the whole block for every dash candidate, which
 * is O(candidates × block). The spans are the same for every candidate, so they
 * are collected once and swept with a pointer. Sorting by start is what lets a
 * single span decide each query: candidates arrive left to right, so once a
 * span ends before the query it can never contain a later one, and the first
 * span that reaches far enough also starts earliest.
 */
export function quotedDashSpans(text) {
  const spans = [];
  for (const re of [/“[^”\n]*—[^”\n]*”/g, /"[^"\n]*—[^"\n]*"/g]) {
    for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

const ANALYSIS = Symbol('writing-check-analysis');

export function checkRecord(record, ordinal = 0, options = {}) {
  const source = String(record.text ?? '');
  if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) throw new Error(`Text exceeds the ${MAX_INPUT_BYTES}-byte limit`);
  const id = sanitizeReportId(record.id ?? `${record.session ?? 'record'}:${record.line ?? ordinal + 1}`);
  const { normalized, stripped, strippedTruncated, omittedStripped } = normalizeMarkdown(source);
  const blocks = makeBlocks(normalized);
  const findings = [], sentenceLengths = [], paragraphSentences = [];
  let sentenceCount = 0, totalWords = 0, omittedFindings = 0;
  const maxFindings = Math.max(0, Math.min(MAX_FINDINGS, Number.isSafeInteger(options.maxFindings) ? options.maxFindings : MAX_FINDINGS));
  /**
   * `start` and `end` are BLOCK-TEXT positions. Rules work in block coordinates
   * throughout and the translation to source happens here, once, so a rule
   * cannot report a raw block index by forgetting to add anything (BG2 was the
   * reverse mistake: every rule added `block.start`, which is only correct while
   * the block text is a verbatim slice).
   */
  const add = (rule, cls, block, sentence, start, end) => {
    if (findings.length >= maxFindings) { omittedFindings++; return; }
    const from = blockOffset(block, start), to = blockOffset(block, end);
    findings.push({ id: rule, class: cls, block: block.index, sentence, offset: { start: from, end: to }, excerpt: excerpt(source, from, to) });
  };
  /** PARA6 marks the whole block, whose bounds are already source offsets. */
  const addSourceSpan = (rule, cls, block, start, end) => {
    if (findings.length >= maxFindings) { omittedFindings++; return; }
    findings.push({ id: rule, class: cls, block: block.index, sentence: null, offset: { start, end }, excerpt: excerpt(source, start, end) });
  };

  for (const block of blocks) {
    block.sentences = segmentSentences(block.text, 0);
    block.words = wordTokens(block.text, 0).length;
    if (!prose(block.type)) continue;
    sentenceCount += block.sentences.length; totalWords += block.words;
    if (block.type === 'paragraph') paragraphSentences.push(block.sentences.length);
    if (block.type === 'paragraph' && block.sentences.length > 6) addSourceSpan('PARA6', 'fail', block, block.start, block.end);

    const scans = [
      ['SEMICOLON', /;/g],
      ['CONTRACTION', /\b(?:i|you|we|they|he|she|it|that|there|here|what|who|how|where|when|why|let)(?:n['’]t|['’](?:re|ll|ve|d|m|s))\b|\b(?:is|are|was|were|do|does|did|has|have|had|can|could|should|would|will|must|might|need|dare|wo|sha)n['’]t\b/gi],
    ];
    for (const [rule, re] of scans) for (const m of block.text.matchAll(re)) add(rule, 'fail', block, null, m.index, m.index + m[0].length);
    for (const m of block.text.matchAll(/(?<!\/)\b[\p{L}]+\/[\p{L}]+\b(?!\/)/gu)) add('SLASHED', 'house-style', block, null, m.index, m.index + m[0].length);

    for (const m of block.text.matchAll(/\(([^()]*)\)/g)) if (finiteCandidate(m[1])) add('PARENTHETICAL_PAREN', 'house-style', block, null, m.index, m.index + m[0].length);
    // Only a block with a dash candidate can produce one, and quotedDashSpans
    // costs two scans of the block.
    const quoted = block.text.includes('—') || block.text.includes('–') ? quotedDashSpans(block.text) : [];
    let quotedIndex = 0;
    for (const m of block.text.matchAll(/(?:—|\s–\s)([^—–\n]+?)(?:—|\s–\s)/g)) {
      const dashStart = m.index, dashEnd = m.index + m[0].length;
      while (quotedIndex < quoted.length && quoted[quotedIndex].end < dashEnd) quotedIndex++;
      const span = quoted[quotedIndex];
      const inQuote = span !== undefined && span.start <= dashStart && span.end >= dashEnd;
      if (!inQuote) add('PARENTHETICAL_DASH', 'house-style', block, null, dashStart, dashEnd);
    }

    block.sentences.forEach((sentence, si) => {
      const tokens = wordTokens(sentence.text, sentence.start);
      sentenceLengths.push(tokens.length);
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
  // SC7: `blocks` still counts every block; only the per-block detail array is
  // bounded, because one 1 MiB record can hold 262,144 of them.
  const detailed = blocks.length > MAX_BLOCK_DETAILS ? blocks.slice(0, MAX_BLOCK_DETAILS) : blocks;
  const result = {
    id, blocks: blocks.length, sentences: sentenceCount, words: totalWords,
    blockDetails: detailed.map(({ index, type, start, end, words, sentences }) => ({ index, type, start, end, words, sentences: sentences.length })),
    blockDetailsTruncated: blocks.length > MAX_BLOCK_DETAILS,
    omittedBlockDetails: Math.max(0, blocks.length - MAX_BLOCK_DETAILS),
    stripped, strippedTruncated, omittedStripped,
    findings, findingsTruncated: omittedFindings > 0, omittedFindings,
  };
  // Keep full analysis private and non-enumerable: aggregate reuses the exact
  // tokenized blocks that produced findings, while JSON and text output stay
  // byte-identical. The blocks retain their BG2 segment maps until every offset
  // and distribution value has been derived.
  Object.defineProperty(result, ANALYSIS, { value: { sentenceLengths, paragraphSentences } });
  return result;
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
/**
 * The findings each record of a run may report.
 *
 * BG6 and FX3 pull in opposite directions and both hold here. Every record of
 * one run gets the SAME allowance, so a record's position never decides what it
 * keeps (BG6), and the run total cannot exceed the record count times that
 * allowance (FX3). The allowance depends only on the record count, so it is the
 * same in any order and for any content.
 *
 * The floor is one finding per record: a run of more records than the total
 * budget still shows every offending record rather than silencing the tail, and
 * `MAX_RECORDS` keeps that floor bounded. Unused allowance is deliberately NOT
 * redistributed to noisier records, because that would make one record's
 * reported count depend on other records again.
 */
export function findingAllowance(recordCount, perRecord = MAX_FINDINGS, total = MAX_TOTAL_FINDINGS) {
  if (!Number.isSafeInteger(recordCount) || recordCount <= 0) return perRecord;
  return Math.max(1, Math.min(perRecord, Math.floor(total / recordCount)));
}

export function aggregate(checked, options = {}) {
  const perRecordLimit = Number.isSafeInteger(options.perRecordLimit) ? options.perRecordLimit : MAX_FINDINGS;
  const allowance = Number.isSafeInteger(options.findingAllowance) ? options.findingAllowance : perRecordLimit;
  const totalWords = checked.reduce((n, r) => n + r.words, 0);
  const rules = {};
  for (const [id, cls] of RULES) {
    const counts = checked.map(r => r.findings.filter(f => f.id === id).length);
    const count = counts.reduce((a, b) => a + b, 0);
    rules[id] = { class: cls, findings: count, records: counts.filter(Boolean).length, ratePer1000Words: totalWords ? count * 1000 / totalWords : 0 };
  }
  const sentenceLengths = [], paragraphSentences = [];
  for (const record of checked) {
    const analysis = record[ANALYSIS];
    if (!analysis) throw new Error('aggregate requires checkRecord results');
    for (const length of analysis.sentenceLengths) sentenceLengths.push(length);
    for (const count of analysis.paragraphSentences) paragraphSentences.push(count);
  }
  const classCount = cls => checked.reduce((n, r) => n + r.findings.filter(f => f.class === cls).length, 0);
  return {
    records: checked.length, words: totalWords,
    failFindings: classCount('fail'), warningFindings: classCount('warning'),
    houseStyleFindings: classCount('house-style'), advisoryFindings: classCount('advisory'),
    findingsTruncated: checked.some(r => r.findingsTruncated),
    truncatedRecords: checked.filter(r => r.findingsTruncated).length,
    omittedFindings: checked.reduce((n, r) => n + r.omittedFindings, 0),
    findingAllowance: allowance,
    runBudgetApplied: allowance < perRecordLimit,
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
  // BG6 + FX3: an equal allowance for every record. It is a per-record cap, so
  // no record is starved by its position, and it is derived from the run budget,
  // so the total output is bounded. Every record that loses findings reports its
  // own shortfall, and formatText states the budget before any finding line.
  const allowance = findingAllowance(records.length, limit);
  const checked = records.map((record, ordinal) => checkRecord(record, ordinal, { maxFindings: allowance }));
  return { records: checked, aggregate: aggregate(checked, { findingAllowance: allowance, perRecordLimit: limit }) };
}

export function formatText(result) {
  const a = result.aggregate;
  const lines = [`Writing check: ${a.records} records, ${a.words} prose words, ${a.failFindings} fail, ${a.warningFindings} warning, ${a.houseStyleFindings} house-style, ${a.advisoryFindings} advisory findings`];
  // FX3: the run budget is stated BEFORE the rule and finding lines, so a
  // reduced report can never read as a complete one.
  if (a.runBudgetApplied) {
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    lines.push(`OUTPUT BUDGET: ${count(a.records, 'record')} share the ${MAX_TOTAL_FINDINGS}-finding run budget, so each record reports at most ${count(a.findingAllowance, 'finding')}; ${count(a.omittedFindings, 'finding')} omitted in ${count(a.truncatedRecords, 'record')}.`);
  }
  for (const [id, x] of Object.entries(a.rules)) lines.push(`${id} [${x.class}]: ${x.findings} findings in ${x.records} records (${x.ratePer1000Words.toFixed(2)}/1000 words)`);
  lines.push(`Sentence words: mean ${a.sentenceLength.mean.toFixed(2)}, median ${a.sentenceLength.median.toFixed(2)}, p90 ${a.sentenceLength.p90.toFixed(2)}, p95 ${a.sentenceLength.p95.toFixed(2)}, max ${a.sentenceLength.max}`);
  lines.push(`Words/record: mean ${a.wordsPerRecord.mean.toFixed(2)}, median ${a.wordsPerRecord.median.toFixed(2)}, p90 ${a.wordsPerRecord.p90.toFixed(2)}, p95 ${a.wordsPerRecord.p95.toFixed(2)}, max ${a.wordsPerRecord.max}`);
  lines.push(`Sentences/paragraph: mean ${a.sentencesPerParagraph.mean.toFixed(2)}, median ${a.sentencesPerParagraph.median.toFixed(2)}, p90 ${a.sentencesPerParagraph.p90.toFixed(2)}, p95 ${a.sentencesPerParagraph.p95.toFixed(2)}, max ${a.sentencesPerParagraph.max}`);
  if (a.findingsTruncated) lines.push(`FINDINGS CAPPED: ${a.omittedFindings} additional findings omitted after the ${a.findingAllowance}-finding limit.`);
  lines.push('NOT CHECKED:');
  for (const x of a.notChecked) lines.push(`- ${x.id}: ${x.reason}`);
  // Report interpolation audit (SC4/SC5/SC9):
  // - r.id is attacker-controlled and sanitized at record creation.
  // - f.excerpt is attacker-controlled and category-stripped + framed.
  // - f.id and f.class come from the closed RULES table.
  // - block, sentence and offsets are checker-generated integers.
  // Everything above this loop is checker-owned literals, closed rule ids/classes,
  // fixed NOT_CHECKED reasons, or computed numbers. No other source text enters.
  for (const r of result.records) for (const f of r.findings) lines.push(`${r.id} b${f.block} s${f.sentence ?? '-'} ${f.id} [${f.class}] ${f.offset.start}-${f.offset.end}: ${f.excerpt}`);
  return lines.join('\n');
}

export function readRegularFile(path, budget) {
  let lst;
  try { lst = fs.lstatSync(path); }
  catch (error) { throw new Error(`Cannot inspect ${path}: ${error.message}`); }
  if (!lst.isFile()) throw new Error(`Refused ${path}: input must be a regular file (no symlinks or special files)`);
  if (lst.size > budget) throw new Error(`Refused ${path}: input exceeds the ${MAX_INPUT_BYTES}-byte total limit`);

  let fd;
  try {
    fd = fs.openSync(path, REGULAR_FILE_OPEN_FLAGS);
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
    let value;
    try {
      value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record must be an object');
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
    }
    records.push(value);
    if (records.length > MAX_RECORDS) throw new Error(`JSONL exceeds the ${MAX_RECORDS}-record limit at line ${index + 1}`);
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

const PROSE_DIFF_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.asciidoc']);
const PROSE_DIFF_NAMES = new Set(['readme', 'changelog', 'changes', 'contributing', 'release_notes']);
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode Git's core.quotePath C string before the path is classified OR
 * reported. Git writes non-ASCII bytes as octal escapes and also escapes tabs,
 * quotes, backslashes and control characters. Classifying the raw label silently
 * dropped a quoted `dóc.md`; decoding only for classification would retain the
 * finding under a false, encoded path.
 */
export function decodeGitPath(label) {
  if (!label.startsWith('"')) return label;
  if (!label.endsWith('"')) throw new Error(`Malformed quoted Git path: ${JSON.stringify(label)}`);
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < label.length - 1; i++) {
    const char = label[i];
    if (char !== '\\') {
      const codePoint = label.codePointAt(i);
      for (const byte of Buffer.from(String.fromCodePoint(codePoint), 'utf8')) bytes.push(byte);
      if (codePoint > 0xffff) i++;
      continue;
    }
    if (++i >= label.length - 1) throw new Error(`Malformed quoted Git path: ${JSON.stringify(label)}`);
    const escaped = label[i];
    if (Object.hasOwn(escapes, escaped)) { bytes.push(escapes[escaped]); continue; }
    if (escaped >= '0' && escaped <= '7') {
      let octal = escaped;
      while (octal.length < 3 && i + 1 < label.length - 1 && label[i + 1] >= '0' && label[i + 1] <= '7') octal += label[++i];
      const byte = Number.parseInt(octal, 8);
      if (byte > 255) throw new Error(`Git path octal escape is not a byte: \\${octal}`);
      bytes.push(byte);
      continue;
    }
    throw new Error(`Unsupported Git path escape \\${escaped}`);
  }
  try { return UTF8_FATAL.decode(Uint8Array.from(bytes)); }
  catch { throw new Error(`Quoted Git path is not valid UTF-8: ${JSON.stringify(label)}`); }
}

/**
 * Diff mode is for prose review, not source review. Include common plain-prose
 * extensions and a small closed set of conventional extensionless prose names.
 * Markdown fences remain the normalizer's responsibility; this filter selects
 * files and does not try to parse their contents.
 */
export function isProseDiffPath(path) {
  const lower = String(path).toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  if (PROSE_DIFF_NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && PROSE_DIFF_EXTENSIONS.has(name.slice(dot));
}

export function recordsFromUnifiedDiff(text, id = 'diff') {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error(`Diff exceeds the ${MAX_INPUT_BYTES}-byte limit`);
  const records = [];
  let file = id, includeFile = isProseDiffPath(file), newLine = 0, runStart = 0, run = [];
  let oldRemaining = 0, newRemaining = 0, inHunk = false;
  const flush = () => {
    if (run.length) {
      if (records.length >= MAX_RECORDS) throw new Error(`Diff exceeds the ${MAX_RECORDS}-record limit`);
      records.push({ id: `${file}:${runStart}`, path: file, addedLine: runStart, text: run.join('\n') });
    }
    run = [];
  };
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (inHunk && oldRemaining === 0 && newRemaining === 0) { flush(); inHunk = false; }
    if (!inHunk && raw.startsWith('+++ ')) {
      flush();
      const label = raw.slice(4).split(/\t/)[0];
      const decoded = decodeGitPath(label);
      file = decoded.startsWith('b/') ? decoded.slice(2) : decoded;
      includeFile = isProseDiffPath(file);
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
    if (hunk) {
      if (inHunk) throw new Error(`Malformed unified diff at line ${index + 1}: prior hunk ended early`);
      flush();
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith('@@')) throw new Error(`Malformed unified diff hunk header at line ${index + 1}: ${JSON.stringify(raw.slice(0, 80))}`);
      continue;
    }
    if (raw.startsWith('\\ No newline at end of file')) continue;
    if (raw.startsWith('+') && newRemaining > 0) {
      if (includeFile) {
        if (!run.length) runStart = newLine;
        run.push(raw.slice(1));
      }
      newLine++; newRemaining--; continue;
    }
    flush();
    if (raw.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      oldRemaining--; newRemaining--; newLine++; continue;
    }
    if (raw.startsWith('-') && oldRemaining > 0) { oldRemaining--; continue; }
    throw new Error(`Malformed unified diff hunk line at line ${index + 1}: ${JSON.stringify(raw.slice(0, 80))}`);
  }
  if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) {
    throw new Error(`Malformed unified diff: final hunk ended early (${oldRemaining} old and ${newRemaining} new lines missing)`);
  }
  flush();
  return records;
}

function usage() {
  return `Usage:\n  node writing-check.mjs --input records.jsonl [--format json|text]\n  node writing-check.mjs --file PATH [--file PATH ...] [--format json|text]\n  node writing-check.mjs --diff changes.diff [--format json|text]\n\n--diff accepts a unified-diff file and checks added lines in prose files. Inputs must be regular files. The combined byte limit is ${MAX_INPUT_BYTES}, the record limit is ${MAX_RECORDS}, and output is capped at ${MAX_FINDINGS} findings per record and ${MAX_TOTAL_FINDINGS} findings per run.`;
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

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try { cli(); }
  catch (error) { console.error(`writing-check: ${error.message}`); process.exitCode = 1; }
}
