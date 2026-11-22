/**
 * Diff de review: cambios commiteados del branch desde el merge-base, más el working tree
 * (staged, unstaged y untracked no ignorados) cuando ese branch está checked out.
 *
 * Se compara contra el merge-base (equivalente three-dot + worktree), no contra la punta de
 * la base: si el branch está detrás, no mezclamos el inverso de commits que solo están en la base.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.mjs";
import { OUTPUT_DIR } from "./output-name.mjs";

const UNTRACKED_MAX_BYTES = 1_000_000;

/** SHA-256 hex del texto exacto que se escribe a disco. */
export function diffFingerprint(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/** 10 hex, mismo ancho que los tips cortos del nombre de archivo. */
export function shortDiffHash(text) {
  return diffFingerprint(text).slice(0, 10);
}

function headBranch(repo) {
  try {
    return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).trim();
  } catch {
    return "";
  }
}

/** El branch bajo review es el que está en el worktree (o HEAD detached en su mismo commit). */
export function isBranchCheckedOut(repo, branch) {
  const name = String(branch || "").trim();
  if (!name) return false;
  const head = headBranch(repo);
  if (head && head !== "HEAD" && head === name) return true;
  if (head !== "HEAD") return false;
  try {
    const headSha = git(repo, ["rev-parse", "HEAD"], { quiet: true }).trim();
    const branchSha = git(repo, ["rev-parse", name], { quiet: true }).trim();
    return Boolean(headSha && branchSha && headSha === branchSha);
  } catch {
    return false;
  }
}

function listUntracked(repo) {
  let raw = "";
  try {
    raw = git(
      repo,
      ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"],
      { quiet: true },
    );
  } catch {
    return [];
  }
  const prefix = `${OUTPUT_DIR}/`;
  return raw
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => p !== OUTPUT_DIR && !p.startsWith(prefix));
}

function syntheticNewFile(relPath, buf) {
  const path = relPath.replace(/\\/g, "/");
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..0000000\n`;
  if (buf.includes(0) || buf.length > UNTRACKED_MAX_BYTES) {
    return `${header}Binary files /dev/null and b/${path} differ\n`;
  }
  const body = buf.toString("utf8").replace(/\r\n/g, "\n");
  const lines = body.length ? body.split("\n") : [];
  const contentLines = body.endsWith("\n") ? lines.slice(0, -1) : lines;
  const n = contentLines.length;
  const plus = contentLines.map((line) => `+${line}`).join("\n");
  return `${header}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${n} @@\n${n ? `${plus}\n` : ""}`;
}

function appendUntracked(repo, text, paths) {
  const chunks = [];
  for (const rel of paths) {
    const abs = join(repo, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    chunks.push(syntheticNewFile(rel, buf));
  }
  if (!chunks.length) return text;
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return base + chunks.join("");
}

/**
 * @param {string} repo
 * @param {{ branch: string, base?: string }} input
 */
export function buildReviewDiff(repo, input) {
  const branch = String(input?.branch || "").trim();
  const base = String(input?.base || "develop").trim() || "develop";
  if (!branch) throw new Error("Falta el branch a revisar.");

  const mergeBase = git(repo, ["merge-base", base, branch]).trim();
  const branchSha = git(repo, ["rev-parse", branch]).trim();
  const baseSha = git(repo, ["rev-parse", base]).trim();
  const includesWorktree = isBranchCheckedOut(repo, branch);

  // Solo este proceso: no reescribe el index y no emite
  // "CRLF will be replaced by LF" al leer un worktree con eol=lf.
  // safecrlf=false no cambia la conversión ni la config del usuario.
  const diffArgs = [
    "--no-optional-locks",
    "-c",
    "core.quotepath=false",
    "-c",
    "core.safecrlf=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
  ];
  const tracked = includesWorktree
    ? git(repo, [...diffArgs, mergeBase])
    : git(repo, [...diffArgs, mergeBase, branch]);

  let text = tracked;
  let untrackedCount = 0;
  if (includesWorktree) {
    const untracked = listUntracked(repo);
    untrackedCount = untracked.length;
    text = appendUntracked(repo, tracked, untracked);
  }

  let dirty = false;
  if (includesWorktree) {
    try {
      dirty = Boolean(
        git(repo, ["--no-optional-locks", "-c", "core.safecrlf=false", "status", "--porcelain"], {
          quiet: true,
        }).trim(),
      );
    } catch {
      dirty = untrackedCount > 0 || Boolean(String(tracked || "").trim());
    }
  }

  return {
    text,
    diffFingerprint: diffFingerprint(text),
    diffHash: shortDiffHash(text),
    dirty,
    includesWorktree,
    mergeBase,
    branchSha,
    baseSha,
    empty: !String(text || "").trim(),
  };
}
