import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, reportId } from "./git.mjs";

const branch = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("reportId is short branch tip then base tip, hyphenated", () => {
  assert.equal(reportId(branch, base), "aaaaaaaaaa-bbbbbbbbbb");
  assert.equal(fingerprint(branch, base), "aaaaaaaaaa-bbbbbbbbbb");
});

test("reportId rejects missing shas", () => {
  assert.equal(fingerprint("", base), null);
  assert.throws(() => reportId("", base), /Faltan SHAs/);
});
