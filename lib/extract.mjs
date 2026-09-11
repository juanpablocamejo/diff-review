import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { capDiff, collectGuidelines, isIgnored, isTestPath, loadReviewConfig } from "./config.mjs";
import { commitLog, git } from "./git.mjs";

export function flattenFiles(report) {
  return Array.isArray(report?.files) ? report.files : [];
}

export function extractBranchDiff({ repo, branch, base = "develop" }) {
  if (!branch) throw new Error("Falta el branch a revisar.");

  const config = loadReviewConfig(repo);
  const mergeBase = git(repo, ["merge-base", base, branch]).trim();
  const branchSha = git(repo, ["rev-parse", branch]).trim();
  const baseSha = git(repo, ["rev-parse", base]).trim();

  const nameStatus = git(repo, ["diff", mergeBase, branch, "--name-status"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      const path = rest[rest.length - 1];
      const oldPath = rest.length > 1 ? rest[0] : null;
      let changeType = "modified";
      if (status.startsWith("A")) changeType = "added";
      else if (status.startsWith("D")) changeType = "deleted";
      else if (status.startsWith("R")) changeType = "renamed";
      return { path, oldPath, changeType };
    });

  const ignored = [];
  const included = [];
  for (const f of nameStatus) {
    if (isIgnored(f.path, config.ignore)) ignored.push(f.path);
    else included.push(f);
  }

  const files = included.map((f) => {
    let raw = "";
    try {
      raw = git(repo, ["diff", mergeBase, branch, "--", f.path]);
      const idx = raw.indexOf("\n@@");
      if (idx !== -1) raw = raw.slice(idx + 1);
    } catch {
      raw = "";
    }
    const capped = capDiff(raw);
    return {
      path: f.path,
      oldPath: f.oldPath || undefined,
      changeType: f.changeType,
      diff: capped.diff,
      diffChars: capped.diffChars,
      truncated: capped.truncated,
      modelChars: capped.diff.length,
      group: "",
    };
  });

  const shortstat = git(repo, ["diff", mergeBase, branch, "--shortstat"]).trim();
  const insMatch = shortstat.match(/(\d+) insertion/);
  const delMatch = shortstat.match(/(\d+) deletion/);

  return {
    version: 2,
    repo,
    branch,
    baseBranch: base,
    mergeBase,
    branchSha,
    baseSha,
    generatedAt: new Date().toISOString(),
    intent: "",
    stats: {
      filesChanged: files.length,
      filesIgnored: ignored.length,
      filesTruncated: files.filter((f) => f.truncated).length,
      insertions: insMatch ? Number(insMatch[1]) : 0,
      deletions: delMatch ? Number(delMatch[1]) : 0,
    },
    context: {
      commits: commitLog(repo, mergeBase, branch),
      rules: config.rules,
      rulesFile: config.rulesFile,
      ignored: ignored.slice(0, 40),
      testsTouched: files.filter((f) => isTestPath(f.path)).map((f) => f.path),
      testsMissing: files.filter((f) => !isTestPath(f.path)).length,
      guidelines: collectGuidelines(repo, files.map((f) => f.path), {
        rulesFile: config.rulesFile,
        skipNames: config.rules.trim() ? [config.rulesFile] : [],
        maxDepth: 1,
        maxChars: 8_000,
        maxTotalChars: 12_000,
      }),
    },
    files,
    groups: [],
    blocks: [],
    findings: [],
    skipped: [],
  };
}

export function writeSkeleton(outPath, skeleton) {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(skeleton, null, 2), "utf8");
  return resolved;
}
