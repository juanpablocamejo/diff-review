import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { extractBranchDiff, parseGitDiffFiles } from "./extract.mjs";
import { OUTPUT_DIR } from "./output-name.mjs";
import { companionPaths, ensureReviewDir, writeDiffText } from "./review-dir.mjs";
import { checkReportFile } from "./check-report.mjs";

const sample = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "-old",
  "+new",
  "+extra",
  "diff --git a/package-lock.json b/package-lock.json",
  "index 1..2 100644",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1 +1 @@",
  "-{}",
  "+{ }",
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "rename from old.ts",
  "rename to new.ts",
  "index 1..2 100644",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
].join("\n");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("parseGitDiffFiles splits paths and change types", () => {
  const files = parseGitDiffFiles(sample);
  assert.equal(files.length, 3);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].changeType, "modified");
  assert.match(files[0].hunkDiff, /^@@/);
  assert.equal(files[1].path, "package-lock.json");
  assert.equal(files[2].changeType, "renamed");
  assert.equal(files[2].path, "new.ts");
  assert.equal(files[2].oldPath, "old.ts");
});

test("extractBranchDiff with cachedDiff applies DEFAULT_IGNORE", () => {
  const repo = mkdtempSync(join(tmpdir(), "diff-review-cache-"));
  dirs.push(repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  // repo path only used for config/guidelines; no git needed when cachedDiff is set
  const skeleton = extractBranchDiff({
    repo,
    branch: "feature",
    base: "develop",
    cachedDiff: sample,
  });
  assert.deepEqual(
    skeleton.files.map((f) => f.path).sort(),
    ["new.ts", "src/a.ts"]
  );
  assert.ok(skeleton.context.ignored.includes("package-lock.json"));
  assert.match(skeleton.files.find((f) => f.path === "src/a.ts").diff, /^@@/);
});

test("checkReportFile reuses companion .diff paths without inventing coverage", () => {
  const repo = mkdtempSync(join(tmpdir(), "diff-review-check-"));
  dirs.push(repo);
  ensureReviewDir(repo);
  const filename = "diff-rev_aaaaaaaaaa_bbbbbbbbbb.json";
  writeDiffText(repo, filename, sample);
  const payload = {
    meta: {
      agent: "Cursor",
      model: "composer",
      repo,
      branch: "feature",
      base: "develop",
    },
    intent: "Cambia src/a.ts y renombra old.ts para dejar el módulo listo en la rama.",
    groups: [{ id: "g1", kind: "feat", title: "Ajuste", intent: "base" }],
    blocks: [
      {
        id: "b1",
        group: "g1",
        file: "src/a.ts",
        lines: "L1-3",
        op: "mod",
        what: "cambia la lógica",
        why: "hace falta",
        source: "code",
      },
      {
        id: "b2",
        group: "g1",
        file: "new.ts",
        lines: "L1",
        op: "rename",
        what: "renombra el módulo",
        why: "nombre más claro",
        source: "code",
      },
    ],
    findings: [],
    skipped: [{ file: "package-lock.json", reason: "lockfile" }],
  };
  const jsonPath = companionPaths(repo, filename).json;
  writeFileSync(jsonPath, JSON.stringify(payload));
  // Sin git: loadBranchDiff lee el .diff y aplica ignore (lockfile fuera de paths).
  const result = checkReportFile(jsonPath, { repo, branch: "feature", base: "develop" });
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("buildPrompt with precomputed context skips merge-base rediscovery", async () => {
  const { buildPrompt } = await import("./prompt.mjs");
  const text = buildPrompt(
    { source: "local", repo: "/tmp/r", branch: "feat", base: "develop" },
    {
      outputFilename: "diff-rev_aaaaaaaaaa_bbbbbbbbbb.json",
      diffRelPath: ".diff-review/diff-rev_aaaaaaaaaa_bbbbbbbbbb.diff",
      mergeBase: "abc123",
      branchSha: "def456",
      baseSha: "789abc",
      files: [{ path: "src/a.ts", changeType: "modified" }],
      ignored: ["package-lock.json"],
      ignoreGlobs: ["**/package-lock.json"],
    }
  );
  assert.match(text, /Precomputed git context/);
  assert.match(text, /diff-rev_aaaaaaaaaa_bbbbbbbbbb\.diff/);
  assert.match(text, /Merge-base SHA: `abc123`/);
  assert.match(text, /modified: src\/a\.ts/);
  assert.doesNotMatch(text, /Resolve the merge-base/);
  assert.doesNotMatch(text, /Run exactly: `git diff/);
});

test("buildPrompt acp omits validate CLI", async () => {
  const { buildPrompt, validateCliCommand } = await import("./prompt.mjs");
  const filename = "diff-rev_aaaaaaaaaa_bbbbbbbbbb.json";
  const text = buildPrompt(
    { source: "local", repo: "/tmp/r", branch: "feat", base: "develop" },
    { outputFilename: filename, acp: true, diffRelPath: `.${OUTPUT_DIR}/${filename.replace(/\.json$/, ".diff")}` }
  );
  assert.doesNotMatch(text, new RegExp(validateCliCommand(filename).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /host validates/i);
});
