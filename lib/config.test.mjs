import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectGuidelines, compactDiff, formatGuidelines, hunkHeaders, modelSlice } from "./config.mjs";

const sample = [
  "diff --git a/src/big.ts b/src/big.ts",
  "--- a/src/big.ts",
  "+++ b/src/big.ts",
  "@@ -1,3 +1,3 @@",
  " import a from 'a';",
  "-const oldHead = 1;",
  "+const newHead = 1;",
  " keep();",
  "@@ -80,4 +80,8 @@ export function later() {",
  "   const ctx = true;",
  "-  return 0;",
  "+  if (!ready) throw new Error('boom');",
  "+  const token = auth();",
  "+  if (!token) return null;",
  "+  return token;",
  " }",
].join("\n");

test("compactDiff drops context lines and keeps hunks", () => {
  const compact = compactDiff(sample);
  assert.equal(compact.includes(" keep();"), false);
  assert.equal(compact.includes("@@ -80,4 +80,8 @@"), true);
  assert.equal(compact.includes("+  if (!ready)"), true);
});

test("hunkHeaders returns @@ lines", () => {
  assert.deepEqual(hunkHeaders(sample, 4), [
    "@@ -1,3 +1,3 @@",
    "@@ -80,4 +80,8 @@ export function later() {",
  ]);
});

test("modelSlice keeps the full unified diff including context", () => {
  const { diff, modelTruncated, modelChars } = modelSlice(sample);
  assert.equal(modelTruncated, false);
  assert.equal(modelChars, sample.length);
  assert.equal(diff.includes(" keep();"), true);
  assert.equal(diff.includes("+const newHead"), true);
  assert.equal(diff.includes("+  if (!ready)"), true);
});

test("modelSlice only clips when a file exceeds max", () => {
  const { diff, modelTruncated } = modelSlice(sample, 80);
  assert.equal(modelTruncated, true);
  assert.equal(diff.includes("el modelo no vio el resto"), true);
});

test("collectGuidelines loads root and nested CLAUDE.md", () => {
  const root = mkdtempSync(join(tmpdir(), "diff-review-g-"));
  try {
    writeFileSync(join(root, "CLAUDE.md"), "root rules");
    writeFileSync(join(root, "REVIEW.md"), "team review");
    mkdirSync(join(root, "apps", "foo"), { recursive: true });
    writeFileSync(join(root, "apps", "foo", "CLAUDE.md"), "nested rules");
    const docs = collectGuidelines(root, ["apps/foo/bar.ts"]);
    const paths = docs.map((d) => d.path);
    assert.ok(paths.includes("CLAUDE.md"));
    assert.ok(paths.includes("REVIEW.md"));
    assert.ok(paths.includes("apps/foo/CLAUDE.md"));
    assert.match(docs.find((d) => d.path === "apps/foo/CLAUDE.md").text, /nested/);
    assert.match(formatGuidelines(docs), /apps\/foo\/CLAUDE\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
