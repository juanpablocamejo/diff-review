/**
 * Precomputa contexto git para el prompt de review (diff cache + lista de archivos).
 * El diff incluye commits desde el merge-base y, si el branch está checked out, el working tree.
 */
import { loadReviewConfig } from "./config.mjs";
import { extractBranchDiff } from "./extract.mjs";
import { makeOutputFilename, outputRelPath } from "./output-name.mjs";
import { ensureReviewDir, writeDiffText } from "./review-dir.mjs";
import { buildReviewDiff } from "./worktree-diff.mjs";

/**
 * Arma el diff, lo escribe en `.diff-review/` y devuelve las opciones de `buildPrompt`.
 * Sin `outputFilename`, el nombre incluye los tips y un hash del contenido del diff.
 * Con `outputFilename` (actualizar un reporte existente) se pisa el companion de ese JSON.
 * @param {{
 *   repo: string,
 *   branch: string,
 *   base?: string,
 *   outputFilename?: string,
 *   acp?: boolean,
 * }} input
 */
export function prepareReviewPromptOpts(input) {
  const repo = String(input.repo || "").trim();
  const branch = String(input.branch || "").trim();
  const base = String(input.base || "develop").trim() || "develop";
  if (!repo || !branch) {
    throw new Error("prepareReviewPromptOpts requiere repo y branch.");
  }

  const built = buildReviewDiff(repo, { branch, base });
  const outputFilename =
    String(input.outputFilename || "").trim() ||
    makeOutputFilename({
      branchSha: built.branchSha,
      baseSha: built.baseSha,
      diffHash: built.diffHash,
    });

  ensureReviewDir(repo);
  writeDiffText(repo, outputFilename, built.text);

  let extracted = null;
  if (!built.empty) {
    extracted = extractBranchDiff({
      repo,
      branch,
      base,
      cachedDiff: built.text,
    });
  }

  const config = loadReviewConfig(repo);
  const diffRelPath = outputRelPath(outputFilename).replace(/\.json$/i, ".diff");

  return {
    outputFilename,
    acp: Boolean(input.acp),
    diffRelPath,
    diffFingerprint: built.diffFingerprint,
    diffHash: built.diffHash,
    dirty: built.dirty,
    empty: built.empty,
    includesWorktree: built.includesWorktree,
    mergeBase: extracted?.mergeBase || built.mergeBase || undefined,
    branchSha: extracted?.branchSha || built.branchSha || undefined,
    baseSha: extracted?.baseSha || built.baseSha || undefined,
    files: (extracted?.files || []).map((f) => ({
      path: f.path,
      changeType: f.changeType,
    })),
    ignored: extracted?.context?.ignored || [],
    ignoreGlobs: config.ignore,
  };
}
