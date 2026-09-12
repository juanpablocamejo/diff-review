import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, reportId, tryResolveGitRoot } from "./git.mjs";

const branch = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("reportId is short branch tip then base tip, hyphenated", () => {
  assert.equal(reportId(branch, base), "aaaaaaaaaa-bbbbbbbbbb");
  assert.equal(fingerprint(branch, base), "aaaaaaaaaa-bbbbbbbbbb");
});

test("reportId rejects missing shas", () => {
  assert.equal(fingerprint("", base), null);
  assert.throws(() => reportId("", base), /Faltan SHAs/);
});

test("tryResolveGitRoot finds repo from subdirectory", () => {
  const root = tryResolveGitRoot(join(repoRoot, "lib"));
  assert.ok(root);
  assert.match(root.replace(/\\/g, "/"), /diff-review$/i);
});

test("tryResolveGitRoot returns null outside a repo", () => {
  assert.equal(tryResolveGitRoot(dirname(repoRoot)), null);
});
