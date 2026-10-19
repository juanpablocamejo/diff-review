/**
 * Precomputa contexto git para el prompt de review (diff cache + lista de archivos).
 */
import { loadReviewConfig } from "./config.mjs";
import { extractBranchDiff } from "./extract.mjs";
import { outputRelPath } from "./output-name.mjs";
import { ensureReviewDir, readDiffCache, writeDiffCache } from "./review-dir.mjs";

/**
 * Cachea el three-dot diff y arma las opciones de `buildPrompt` (tips, files, ignores).
 * @param {{
 *   repo: string,
 *   branch: string,
 *   base?: string,
 *   outputFilename: string,
 *   acp?: boolean,
 * }} input
 */
export function prepareReviewPromptOpts(input) {
  const repo = String(input.repo || "").trim();
  const branch = String(input.branch || "").trim();
  const base = String(input.base || "develop").trim() || "develop";
  const outputFilename = String(input.outputFilename || "").trim();
  if (!repo || !branch || !outputFilename) {
    throw new Error("prepareReviewPromptOpts requiere repo, branch y outputFilename.");
  }

  ensureReviewDir(repo);
  writeDiffCache(repo, outputFilename, { branch, base });
  const cached = readDiffCache(repo, outputFilename);

  let extracted;
  try {
    extracted = extractBranchDiff({
      repo,
      branch,
      base,
      ...(cached ? { cachedDiff: cached } : {}),
    });
  } catch {
    extracted = extractBranchDiff({ repo, branch, base });
  }

  const config = loadReviewConfig(repo);
  const diffRelPath = cached
    ? outputRelPath(outputFilename).replace(/\.json$/i, ".diff")
    : null;

  return {
    outputFilename,
    acp: Boolean(input.acp),
    diffRelPath,
    mergeBase: extracted.mergeBase || undefined,
    branchSha: extracted.branchSha || undefined,
    baseSha: extracted.baseSha || undefined,
    files: (extracted.files || []).map((f) => ({
      path: f.path,
      changeType: f.changeType,
    })),
    ignored: extracted.context?.ignored || [],
    ignoreGlobs: config.ignore,
  };
}
