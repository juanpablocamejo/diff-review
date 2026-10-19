import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { capDiff, collectGuidelines, isIgnored, isTestPath, loadReviewConfig } from "./config.mjs";
import { commitLog, git } from "./git.mjs";
import { readDiffCache } from "./review-dir.mjs";

export function flattenFiles(report) {
  return Array.isArray(report?.files) ? report.files : [];
}

/**
 * Parte un `git diff` multi-archivo (texto de `writeDiffCache`) en entradas por path.
 * @param {string} text
 * @returns {Array<{ path: string, oldPath?: string, changeType: string, hunkDiff: string }>}
 */
export function parseGitDiffFiles(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  if (!raw.trim()) return [];

  const parts = raw.split(/^diff --git /m);
  /** @type {Array<{ path: string, oldPath?: string, changeType: string, hunkDiff: string }>} */
  const out = [];

  for (const part of parts) {
    const chunk = part.trimStart();
    if (!chunk) continue;

    const firstNl = chunk.indexOf("\n");
    const firstLine = (firstNl === -1 ? chunk : chunk.slice(0, firstNl)).trim();
    // `a/path b/path` (paths sin espacios raros; el formato de git suele ser este)
    const paths = firstLine.match(/^a\/(.+) b\/(.+)$/);
    if (!paths) continue;

    let oldPath = paths[1];
    let path = paths[2];
    const body = firstNl === -1 ? "" : chunk.slice(firstNl + 1);

    let changeType = "modified";
    if (/^new file mode /m.test(body) || /^--- \/dev\/null/m.test(body)) changeType = "added";
    else if (/^deleted file mode /m.test(body) || /^\+\+\+ \/dev\/null/m.test(body)) changeType = "deleted";
    else if (/^rename from /m.test(body) || /^rename to /m.test(body)) {
      changeType = "renamed";
      const from = body.match(/^rename from (.+)$/m);
      const to = body.match(/^rename to (.+)$/m);
      if (from) oldPath = from[1].trim();
      if (to) path = to[1].trim();
    }

    let hunkDiff = "";
    const idx = `\n${body}`.indexOf("\n@@");
    if (idx !== -1) hunkDiff = `\n${body}`.slice(idx + 1);
    else if (/^Binary files /m.test(body)) hunkDiff = "";

    out.push({
      path,
      oldPath: oldPath !== path ? oldPath : undefined,
      changeType,
      hunkDiff,
    });
  }

  return out;
}

/**
 * Stats baratos desde el texto del diff (sin volver a llamar a git).
 * @param {string} text
 */
function statsFromDiffText(text) {
  let insertions = 0;
  let deletions = 0;
  for (const line of String(text || "").split("\n")) {
    if (!line.length) continue;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { insertions, deletions };
}

/**
 * Tips / merge-base si git responde; si no, strings vacíos (el contenido del diff ya viene del cache).
 */
function tryTips(repo, branch, base) {
  try {
    return {
      mergeBase: git(repo, ["merge-base", base, branch]).trim(),
      branchSha: git(repo, ["rev-parse", branch]).trim(),
      baseSha: git(repo, ["rev-parse", base]).trim(),
    };
  } catch {
    return { mergeBase: "", branchSha: "", baseSha: "" };
  }
}

/**
 * Arma el mismo shape que `extractBranchDiff` a partir de un texto de `git diff` ya cacheado.
 * No vuelve a correr `git diff`.
 */
function skeletonFromCachedDiff(repo, branch, base, cachedDiff) {
  const config = loadReviewConfig(repo);
  const tips = tryTips(repo, branch, base);
  const parsed = parseGitDiffFiles(cachedDiff);

  const ignored = [];
  const included = [];
  for (const f of parsed) {
    if (isIgnored(f.path, config.ignore)) ignored.push(f.path);
    else included.push(f);
  }

  const files = included.map((f) => {
    const capped = capDiff(f.hunkDiff);
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

  const { insertions, deletions } = statsFromDiffText(cachedDiff);
  let commits = [];
  if (tips.mergeBase) {
    try {
      commits = commitLog(repo, tips.mergeBase, branch);
    } catch {
      commits = [];
    }
  }

  return {
    version: 2,
    repo,
    branch,
    baseBranch: base,
    mergeBase: tips.mergeBase,
    branchSha: tips.branchSha,
    baseSha: tips.baseSha,
    generatedAt: new Date().toISOString(),
    intent: "",
    stats: {
      filesChanged: files.length,
      filesIgnored: ignored.length,
      filesTruncated: files.filter((f) => f.truncated).length,
      insertions,
      deletions,
    },
    context: {
      commits,
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

/**
 * @param {{
 *   repo: string,
 *   branch: string,
 *   base?: string,
 *   cachedDiff?: string | null,
 * }} opts
 *   `cachedDiff`: texto de `git diff base...branch` ya materializado; si viene, no se vuelve a calcular el diff.
 */
export function extractBranchDiff({ repo, branch, base = "develop", cachedDiff = null } = {}) {
  if (!branch) throw new Error("Falta el branch a revisar.");

  if (typeof cachedDiff === "string" && cachedDiff.length) {
    return skeletonFromCachedDiff(repo, branch, base, cachedDiff);
  }

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

/**
 * Preferí el companion `.diff` en `.diff-review/` si existe; si no, `git diff` vía `extractBranchDiff`.
 * @param {{ repo: string, branch: string, base?: string, filename?: string }} opts
 */
export function loadBranchDiff({ repo, branch, base = "develop", filename } = {}) {
  const name = String(filename || "").trim();
  if (name) {
    const cached = readDiffCache(repo, name);
    if (cached != null && cached.length) {
      return extractBranchDiff({ repo, branch, base, cachedDiff: cached });
    }
  }
  return extractBranchDiff({ repo, branch, base });
}

export function writeSkeleton(outPath, skeleton) {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(skeleton, null, 2), "utf8");
  return resolved;
}
