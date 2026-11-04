#!/usr/bin/env node
/*
 * Arguments: create|preserve [--expected HASH] -- SOURCE DESTINATION,
 * compare -- FIRST SECOND, hash [--expected HASH] -- FILE, or --help.
 * HASH is a full SHA-256 digest. SHA-256 is the Secure Hash Algorithm
 * with a 256-bit result. Paths after -- can start with a dash.
 * Quote paths for the shell. Escape embedded single quotes.
 *
 * create exclusively creates and verifies a new copy. preserve does the
 * same and also checks whether an occupied file provides separate retention.
 * compare checks complete bytes without writing. hash reads one full digest.
 * Expected identity is checked before destination access. A changed digest
 * during comparison refuses success even if metadata still agrees.
 *
 * Exit codes: 0 ok, 2 usage, 3 occupied, 4 different, 5 identity,
 * 6 io, 7 changed, 8 unsafe-file. Usage includes unavailable exclusive
 * creation. Occupied never means new creation, even when bytes agree.
 * Different means unequal comparison bytes. Identity means an expected
 * digest mismatch. Io means an input/output failure. Changed means an
 * observed identity, metadata or source-digest change. Unsafe-file means
 * a symbolic link or nonregular leaf. The first file failure stays primary.
 *
 * Each non-help invocation attempts one JSON (JavaScript Object Notation)
 * report on standard output. Fields have these closed meanings:
 * operation: create, preserve, compare, hash, or invalid for an unknown verb.
 * code: one of the exit-code names above.
 * stage: arguments, source, destination, copy, compare, complete, or output.
 * It identifies the first failure phase or complete success.
 * writeState: not-created, created-unverified, or verified. Only this
 * invocation's exclusive creation can reach the latter two values.
 * equal: null before a completed comparison, otherwise true or false.
 * sourceHash and destinationHash: null or a lowercase 64-digit digest.
 * sourceHash uses the latest completed read. destinationHash needs comparison.
 * expected: not-supplied, not-checked, agreed, or differs. Agreed describes
 * the first digest check, not a guarantee against later source changes.
 * retainedVerified: true only for preserve with complete equal bytes,
 * stable distinct source and destination identities, and successful closes.
 * An occupied equal distinct file can qualify with exit 3 and not-created.
 * A same-path or hard-link alias cannot qualify. Any other failure clears it.
 * Retention establishes observed bytes, not approval or caller authority.
 *
 * protections has exactly exclusiveCreate, noFollowOpen, nonblockingOpen,
 * and mode0600. Values are applied, unavailable, or not-applicable.
 * Open values describe flags requested in attempted opens, even on refusal.
 * Unavailable is cumulative when an optional flag falls back or is absent.
 * Exclusive creation never falls back. An unsupported exclusive open reports
 * exclusiveCreate as unavailable. Mode describes observed created-file
 * permissions, not merely the requested mode. No creation leaves mode
 * not-applicable. Windows reports optional open flags and mode unavailable.
 * Windows uses checked ordinary opens and can follow an unobserved link swap.
 *
 * Callers may rely on exclusive creation, complete comparison and the
 * reported observations. Parent links are not an access boundary. Checks
 * do not provide an atomic snapshot against a hostile same-user process.
 * No replacement, deletion, cleanup or power-loss durability is promised.
 * Partial bytes remain. Missing reports or signals mean unknown write state.
 * Report output failure selects exit 6 and attempts the fixed io diagnostic.
 * Once a report is emitted, its code and exit status remain authoritative
 * even if standard-error delivery fails. Diagnostics are best effort.
 * Output limits including line endings: help 1024 bytes, report 2048 bytes,
 * standard error 256 bytes. Reports contain no paths or operating-system text.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

const exits = { ok: 0, usage: 2, occupied: 3, different: 4, identity: 5, io: 6, changed: 7, 'unsafe-file': 8 };
const help = `Usage: node safe-record-write.mjs OP [--expected HASH] -- SOURCE [DESTINATION]
create: exclusive creation and full copy verification.
preserve: create, or check separate equal retention at an occupied name.
compare: compare complete bytes without writes. No --expected.
hash: hash one file. --help: show this text without file access.
HASH: full SHA-256 digest, 64 hexadecimal digits.
SHA-256 is the Secure Hash Algorithm with a 256-bit result.
Exits: 0 ok, 2 usage, 3 occupied, 4 different, 5 identity mismatch,
6 input/output failure, 7 observed change, 8 unsafe file.
Quote shell paths and escape embedded single quotes. Use -- before paths.
Links and nonregular leaves are refused. Parent links are not an access boundary.
Windows has reduced open and mode protection. See ../docs/safe-record-write.md (relative to this command) for report
fields and retention rules. Missing report means unknown write state.
Partial files remain. No replacement, approval or power-loss durability is promised.
`;
const fail = (code) => { throw Object.assign(new Error(code), { recordCode: code }); };
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;
const same = (a, b) => sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const stat = (fd) => fs.fstatSync(fd, { bigint: true });
function leaf(path) {
  const value = fs.lstatSync(path, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink()) fail('unsafe-file');
  return value;
}
function classify(error) {
  return error?.recordCode ?? (error?.code === 'ELOOP' ? 'unsafe-file' : 'io');
}

const report = {
  operation: 'invalid', code: 'usage', stage: 'arguments', writeState: 'not-created',
  equal: null, sourceHash: null, destinationHash: null, retainedVerified: false,
  expected: 'not-supplied',
  protections: { exclusiveCreate: 'not-applicable', noFollowOpen: 'not-applicable',
    nonblockingOpen: 'not-applicable', mode0600: 'not-applicable' },
};
function protection(key, used) {
  const value = used ? 'applied' : 'unavailable';
  if (report.protections[key] !== 'unavailable') report.protections[key] = value;
}
function checkedOpen(path, create = false) {
  const c = fs.constants;
  if (create && (!c.O_EXCL || !c.O_CREAT)) {
    report.protections.exclusiveCreate = 'unavailable';
    fail('usage');
  }
  const base = create ? c.O_RDWR | c.O_CREAT | c.O_EXCL : c.O_RDONLY;
  let nofollow = process.platform !== 'win32' && !!c.O_NOFOLLOW;
  let nonblock = process.platform !== 'win32' && !!c.O_NONBLOCK;
  let fd;
  protection('noFollowOpen', nofollow);
  protection('nonblockingOpen', nonblock);
  if (create) report.protections.exclusiveCreate = 'applied';
  try {
    fd = fs.openSync(path, base | (nofollow ? c.O_NOFOLLOW : 0) | (nonblock ? c.O_NONBLOCK : 0), 0o600);
  } catch (error) {
    const unsupported = ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code);
    if (!(nofollow || nonblock) || !(unsupported || error.code === 'EINVAL')) {
      if (create && unsupported) {
        report.protections.exclusiveCreate = 'unavailable';
        fail('usage');
      }
      throw error;
    }
    // Retry only optional flags. Exclusive creation stays required.
    nofollow = false;
    nonblock = false;
    protection('noFollowOpen', false);
    protection('nonblockingOpen', false);
    try { fd = fs.openSync(path, base, 0o600); }
    catch (fallback) {
      if (create && ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(fallback.code)) {
        report.protections.exclusiveCreate = 'unavailable';
        fail('usage');
      }
      throw fallback;
    }
  }
  if (create) {
    report.writeState = 'created-unverified';
  }
  protection('noFollowOpen', nofollow);
  protection('nonblockingOpen', nonblock);
  return fd;
}
function check(file) {
  const current = stat(file.fd);
  if (!current.isFile()) fail('unsafe-file');
  let named;
  try { named = leaf(file.path); }
  catch (error) { if (error.code === 'ENOENT') fail('changed'); throw error; }
  if (!same(file.meta, current) || !same(current, named)) fail('changed');
}
function readOpen(path) {
  const before = leaf(path);
  const fd = checkedOpen(path);
  try {
    const meta = stat(fd);
    if (!meta.isFile()) fail('unsafe-file');
    if (!same(before, meta)) fail('changed');
    const file = { path, fd, meta };
    check(file);
    return file;
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    throw error;
  }
}
function digest(file) {
  check(file);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  let position = 0, count;
  while ((count = fs.readSync(file.fd, buffer, 0, buffer.length, position)) !== 0) {
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  check(file);
  return hash.digest('hex');
}
function compare(source, destination) {
  check(source);
  check(destination);
  const hashes = [createHash('sha256'), createHash('sha256')];
  const buffers = [Buffer.alloc(65536), Buffer.alloc(65536)];
  const positions = [0, 0];
  let equal = true;
  // Fill each chunk completely so short reads cannot manufacture a difference.
  function chunk(index, file) {
    let used = 0;
    while (used < buffers[index].length) {
      const count = fs.readSync(file.fd, buffers[index], used, buffers[index].length - used, positions[index]);
      if (!count) break;
      positions[index] += count;
      used += count;
    }
    hashes[index].update(buffers[index].subarray(0, used));
    return used;
  }
  while (true) {
    const a = chunk(0, source), b = chunk(1, destination);
    if (a !== b || !buffers[0].subarray(0, a).equals(buffers[1].subarray(0, b))) equal = false;
    if (!a && !b) break;
  }
  check(source);
  check(destination);
  report.sourceHash = hashes[0].digest('hex');
  report.destinationHash = hashes[1].digest('hex');
  report.equal = equal;
}
function copy(source, fd) {
  check(source);
  const buffer = Buffer.alloc(65536);
  let position = 0, count;
  while ((count = fs.readSync(source.fd, buffer, 0, buffer.length, position)) !== 0) {
    let written = 0;
    while (written < count) {
      const n = fs.writeSync(fd, buffer, written, count - written, position + written);
      if (!n) fail('io');
      written += n;
    }
    position += count;
  }
  check(source);
}
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const operation = args.shift();
  if (!['create', 'preserve', 'compare', 'hash'].includes(operation)) fail('usage');
  report.operation = operation;
  let expected;
  if (args[0] === '--expected') {
    args.shift();
    expected = args.shift();
    report.expected = 'not-checked';
    if (operation === 'compare' || !/^[a-fA-F0-9]{64}$/.test(expected ?? '')) fail('usage');
    expected = expected.toLowerCase();
  }
  if (args.shift() !== '--' || args.length !== (operation === 'hash' ? 1 : 2) || args.some(p => !p || p.includes('\0'))) fail('usage');
  return { operation, expected, paths: args };
}
function execute(input) {
  const opened = [];
  let primary;
  try {
    report.stage = 'source';
    const source = readOpen(input.paths[0]);
    opened.push(source);
    report.sourceHash = digest(source);
    const firstHash = report.sourceHash;
    if (input.expected) {
      report.expected = report.sourceHash === input.expected ? 'agreed' : 'differs';
      if (report.expected === 'differs') fail('identity');
    }
    if (input.operation === 'hash') return;
    report.stage = 'destination';
    let destination, occupied = false, occupiedMeta, createdMeta;
    if (input.operation === 'compare') {
      destination = readOpen(input.paths[1]);
      opened.push(destination);
    } else {
      try { occupiedMeta = leaf(input.paths[1]); occupied = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let fd;
      if (!occupied) {
        try { fd = checkedOpen(input.paths[1], true); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          try { occupiedMeta = leaf(input.paths[1]); occupied = true; }
          catch (observed) { if (observed.code === 'ENOENT') fail('changed'); throw observed; }
        }
      }
      if (fd !== undefined) {
        try {
          createdMeta = stat(fd);
          report.protections.mode0600 = process.platform !== 'win32' && (createdMeta.mode & 0o077n) === 0n ? 'applied' : 'unavailable';
          if (!createdMeta.isFile()) fail('unsafe-file');
          let named;
          try { named = leaf(input.paths[1]); }
          catch (error) { if (error.code === 'ENOENT') fail('changed'); throw error; }
          if (createdMeta.size !== 0n || !sameObject(createdMeta, named)) fail('changed');
          report.stage = 'copy';
          copy(source, fd);
        } catch (error) { primary = error; }
        try { fs.closeSync(fd); } catch (error) { primary ??= error; }
      }
      try {
        destination = readOpen(input.paths[1]);
        opened.push(destination);
        if (createdMeta && !sameObject(createdMeta, destination.meta)) fail('changed');
        if (occupiedMeta && !same(occupiedMeta, destination.meta)) fail('changed');
      } catch (error) {
        destination = undefined;
        if (!primary) {
          if (error.code === 'ENOENT') fail('changed');
          throw error;
        }
      }
    }
    if (destination) {
      const failureStage = primary ? report.stage : undefined;
      if (!primary) report.stage = 'compare';
      try {
        compare(source, destination);
        if (report.sourceHash !== firstHash) fail('changed');
      } catch (error) { primary ??= error; }
      if (failureStage) report.stage = failureStage;
    }
    if (primary) throw primary;
    check(source);
    if (occupied) {
      report.retainedVerified = input.operation === 'preserve' && report.equal === true && !sameObject(source.meta, destination.meta);
      fail('occupied');
    }
    if (!report.equal) fail('different');
    if (input.operation !== 'compare') {
      report.writeState = 'verified';
      report.retainedVerified = input.operation === 'preserve';
    }
  } catch (error) { primary ??= error; }
  finally {
    for (const file of opened.reverse()) {
      try { fs.closeSync(file.fd); }
      catch (error) {
        if (!primary || ['occupied', 'different'].includes(classify(primary))) primary = error;
      }
    }
    if (primary) {
      if (report.writeState === 'verified') report.writeState = 'created-unverified';
      report.retainedVerified = false;
      // Occupied retention has no new creation claim.
      if (classify(primary) === 'occupied') report.retainedVerified = input.operation === 'preserve' && report.equal === true && opened.length === 2 && !sameObject(opened[0].meta, opened[1].meta);
      throw primary;
    }
  }
}
async function output(stream, text) {
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.write(text, error => { stream.removeListener('error', reject); error ? reject(error) : resolve(); });
  });
}
async function main() {
  let input;
  try {
    input = parse(process.argv.slice(2));
    if (input.help) { await output(process.stdout, help); return; }
    execute(input);
    report.code = 'ok';
    report.stage = 'complete';
  } catch (error) { report.code = classify(error); }
  try {
    await output(process.stdout, JSON.stringify(report) + '\n');
    process.exitCode = exits[report.code];
    if (report.code !== 'ok') {
      try { await output(process.stderr, `safe-record-write: ${report.code}\n`); } catch {}
    }
  } catch {
    report.code = 'io';
    report.stage = 'output';
    process.exitCode = 6;
    try { await output(process.stderr, 'safe-record-write: io\n'); } catch {}
  }
}
// Stream errors remain handled even after a failed write callback.
process.stdout.on('error', () => { process.exitCode = 6; });
process.stderr.on('error', () => {});
main().catch(() => { process.exitCode = 6; });
