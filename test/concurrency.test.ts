import assert from "node:assert/strict";
import test from "node:test";
import { commitCodemodeLimit, DEFAULT_MAX_CONCURRENT, sanitizeMaxConcurrent } from "../extension/concurrency.ts";

const key = Symbol.for("ytdb-slate.codemode-limit.v1");
const shared = globalThis as typeof globalThis & { [key]?: { lastWritten?: string } };
const warning = "slate: maxConcurrent must be a positive safe integer. Using 8.";

test("concurrency validation accepts only positive safe integers", () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.equal(DEFAULT_MAX_CONCURRENT, 8);
  assert.equal(sanitizeMaxConcurrent(undefined, warn), 8);
  for (const value of [1, 8, Number.MAX_SAFE_INTEGER]) assert.equal(sanitizeMaxConcurrent(value, warn), value);
  assert.deepEqual(warnings, []);
  const invalid = [null, true, false, "", "8", [], {}, 1.5, NaN, Infinity, -Infinity, 0, -1, Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalid) assert.equal(sanitizeMaxConcurrent(value, warn), 8);
  assert.deepEqual(warnings, invalid.map(() => warning));
});

test("process ownership preserves exact overrides and survives module copies", async () => {
  const previous = process.env.PI_CODEMODE_MAX_WORKERS;
  const hadRecord = Object.hasOwn(shared, key);
  const record = shared[key];
  try {
    for (const value of ["", "1", "9", "invalid", "08"]) {
      delete shared[key];
      process.env.PI_CODEMODE_MAX_WORKERS = value;
      commitCodemodeLimit(8);
      assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, value);
      assert.deepEqual(shared[key], {});
    }
    delete process.env.PI_CODEMODE_MAX_WORKERS;
    delete shared[key];
    commitCodemodeLimit(3);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "3");
    commitCodemodeLimit(8);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "8");
    commitCodemodeLimit(1);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");
    process.env.PI_CODEMODE_MAX_WORKERS = "9";
    commitCodemodeLimit(4);
    assert.deepEqual(shared[key], {});
    process.env.PI_CODEMODE_MAX_WORKERS = "1";
    commitCodemodeLimit(4);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1", "an old owned string remains external after revocation");
    delete process.env.PI_CODEMODE_MAX_WORKERS;
    commitCodemodeLimit(3);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "3");
    delete process.env.PI_CODEMODE_MAX_WORKERS;
    commitCodemodeLimit(8);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "8");
    const copy = await import(new URL("../extension/concurrency.ts?ownership-copy", import.meta.url).href);
    copy.commitCodemodeLimit(1);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "1");
    process.env.PI_CODEMODE_MAX_WORKERS = "1";
    commitCodemodeLimit(3);
    assert.equal(process.env.PI_CODEMODE_MAX_WORKERS, "3", "same-value external rewrites cannot be detected");
  } finally {
    try {
      if (previous === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
      else process.env.PI_CODEMODE_MAX_WORKERS = previous;
    } finally {
      if (hadRecord) shared[key] = record;
      else delete shared[key];
    }
  }
});
