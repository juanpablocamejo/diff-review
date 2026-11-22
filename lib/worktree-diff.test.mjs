import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeOutputFilename } from "./output-name.mjs";
import { prepareReviewPromptOpts } from "./review-prep.mjs";
import { readDiffCache } from "./review-dir.mjs";
import { buildReviewDiff } from "./worktree-diff.mjs";
import { branchBehind, fastForwardBranch } from "./git.mjs";

const tmp = mkdtempSync(join(tmpdir(), "diff-review-wt-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "diff-review",
  GIT_AUTHOR_EMAIL: "diff-review@example.com",
  GIT_COMMITTER_NAME: "diff-review",
  GIT_COMMITTER_EMAIL: "diff-review@example.com",
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

function initRepo(dir) {
  git(tmp, ["init", "-b", "main", dir]);
  git(dir, ["config", "user.email", "diff-review@example.com"]);
  git(dir, ["config", "user.name", "diff-review"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-m", "base"]);
}

test("review diff includes committed, unstaged, and untracked files", () => {
  const repo = join(tmp, "feature");
  initRepo(repo);
  git(repo, ["checkout", "-b", "feature"]);
  writeFileSync(join(repo, "a.txt"), "committed\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  writeFileSync(join(repo, "a.txt"), "committed\nand dirty\n");
  writeFileSync(join(repo, "new.txt"), "untracked\n");

  const built = buildReviewDiff(repo, { branch: "feature", base: "main" });
  assert.equal(built.includesWorktree, true);
  assert.equal(built.dirty, true);
  assert.equal(built.empty, false);
  assert.match(built.text, /and dirty/);
  assert.match(built.text, /new file mode/);
  assert.match(built.text, /b\/new\.txt/);
  assert.match(built.text, /\+untracked/);

  const prepared = prepareReviewPromptOpts({ repo, branch: "feature", base: "main" });
  assert.match(prepared.outputFilename, /^diff-rev_[0-9a-f]{10}_[0-9a-f]{10}_[0-9a-f]{10}\.json$/);
  assert.equal(prepared.diffFingerprint, built.diffFingerprint);
  const paths = prepared.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["a.txt", "new.txt"]);
  const cached = readDiffCache(repo, prepared.outputFilename);
  assert.equal(cached, built.text);

  const cleanName = makeOutputFilename({
    branchSha: built.branchSha,
    baseSha: built.baseSha,
  });
  assert.notEqual(prepared.outputFilename, cleanName);
});

test("a checked-out CRLF worktree diffs without warnings or index writes", () => {
  const repo = join(tmp, "crlf");
  initRepo(repo);
  git(repo, ["config", "core.autocrlf", "input"]);
  git(repo, ["config", "core.safecrlf", "warn"]);
  writeFileSync(join(repo, ".gitattributes"), "* text=auto eol=lf\n");
  git(repo, ["add", ".gitattributes"]);
  git(repo, ["commit", "-m", "attrs"]);
  git(repo, ["checkout", "-b", "feature"]);
  writeFileSync(join(repo, "a.txt"), "committed\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  writeFileSync(join(repo, "a.txt"), "committed\r\nand dirty\r\n");
  writeFileSync(join(repo, "new.txt"), "untracked\r\n");

  const baseline = spawnSync("git", ["diff", "main"], { cwd: repo, encoding: "utf8" });
  assert.equal(baseline.status, 0);
  assert.match(baseline.stderr || "", /CRLF will be replaced by LF/);

  const indexBefore = readFileSync(join(repo, ".git", "index"));
  const mod = new URL("./worktree-diff.mjs", import.meta.url).href;
  const script = `
    import { buildReviewDiff } from ${JSON.stringify(mod)};
    const built = buildReviewDiff(${JSON.stringify(repo)}, { branch: "feature", base: "main" });
    process.stdout.write(JSON.stringify({
      includesWorktree: built.includesWorktree,
      dirty: built.dirty,
      empty: built.empty,
      text: built.text,
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr || "", /CRLF will be replaced by LF/);
  assert.doesNotMatch(result.stderr || "", /LF will be replaced by CRLF/);
  assert.deepEqual(readFileSync(join(repo, ".git", "index")), indexBefore);

  const built = JSON.parse(result.stdout);
  assert.equal(built.includesWorktree, true);
  assert.equal(built.dirty, true);
  assert.equal(built.empty, false);
  assert.match(built.text, /\+and dirty/);
  assert.match(built.text, /\+untracked/);
  assert.doesNotMatch(built.text, /\r/);
});

test("a branch that is not checked out does not pick up another worktree", () => {
  const repo = join(tmp, "other-branch");
  initRepo(repo);
  git(repo, ["checkout", "-b", "feature"]);
  writeFileSync(join(repo, "a.txt"), "on feature\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  git(repo, ["checkout", "main"]);
  writeFileSync(join(repo, "dirty.txt"), "only on main\n");

  const built = buildReviewDiff(repo, { branch: "feature", base: "main" });
  assert.equal(built.includesWorktree, false);
  assert.equal(built.dirty, false);
  assert.match(built.text, /on feature/);
  assert.doesNotMatch(built.text, /dirty\.txt/);
});

test("fast-forward updates a behind branch and refuses a dirty checkout", () => {
  const bare = join(tmp, "bare.git");
  const local = join(tmp, "local");
  const other = join(tmp, "other");
  git(tmp, ["init", "--bare", "-b", "main", bare]);
  git(tmp, ["clone", bare, local]);
  git(local, ["config", "user.email", "diff-review@example.com"]);
  git(local, ["config", "user.name", "diff-review"]);
  writeFileSync(join(local, "a.txt"), "one\n");
  git(local, ["add", "a.txt"]);
  git(local, ["commit", "-m", "one"]);
  git(local, ["push", "-u", "origin", "HEAD"]);

  git(tmp, ["clone", bare, other]);
  git(other, ["config", "user.email", "diff-review@example.com"]);
  git(other, ["config", "user.name", "diff-review"]);
  writeFileSync(join(other, "a.txt"), "two\n");
  git(other, ["add", "a.txt"]);
  git(other, ["commit", "-m", "two"]);
  git(other, ["push"]);

  git(local, ["fetch"]);
  const behind = branchBehind(local, "main");
  assert.equal(behind.behind, 1);
  assert.equal(behind.upstream, "origin/main");

  writeFileSync(join(local, "wip.txt"), "wip\n");
  assert.throws(() => fastForwardBranch(local, "main"), /sin commitear/);
  assert.match(readFileSync(join(local, "a.txt"), "utf8"), /one/);

  git(local, ["clean", "-fd"]);
  const after = fastForwardBranch(local, "main");
  assert.equal(after.behind, 0);
  assert.match(readFileSync(join(local, "a.txt"), "utf8"), /two/);
});
