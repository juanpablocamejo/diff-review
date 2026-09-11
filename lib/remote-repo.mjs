import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./git.mjs";

const CACHE_ROOT = join(tmpdir(), "diff-review-clones");
const MAX_DEEPEN_ROUNDS = 8;
const DEEPEN_BY = "50";

export function looksLikeGitUrl(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(v)) return true;
  if (/\.git$/i.test(v) && !/^[A-Za-z]:/.test(v) && !v.startsWith("/") && !v.startsWith("\\")) {
    return true;
  }
  return false;
}

export function normalizeGitUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) throw new Error("Indicá la URL del repositorio.");
  if (!looksLikeGitUrl(raw)) {
    throw new Error(
      `"${raw}" no parece una URL git. Usá https://…, git@… o ssh://…`,
    );
  }
  if (/^(file:|javascript:|data:)/i.test(raw)) {
    throw new Error("Esquema de URL no permitido.");
  }
  return raw.replace(/\/$/, "");
}

function cacheDirFor(url) {
  const key = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return join(CACHE_ROOT, key);
}

function runGit(args, { cwd, timeout = 5 * 60 * 1000 } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Lista heads del remote sin clonar. */
export function listRemoteBranches(url) {
  const remote = normalizeGitUrl(url);
  let raw;
  try {
    raw = runGit(["ls-remote", "--heads", remote]);
  } catch (err) {
    const stderr = String(/** @type {{ stderr?: string }} */ (err).stderr || err.message || err);
    throw new Error("No se pudo listar branches del remote: " + stderr.split("\n").find(Boolean));
  }

  const branches = [
    ...new Set(
      raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const ref = line.split("\t")[1] || "";
          return ref.replace(/^refs\/heads\//, "");
        })
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));

  if (!branches.length) {
    throw new Error("El remote no expone branches (refs/heads).");
  }

  const defaultBase = branches.includes("develop")
    ? "develop"
    : branches.includes("main")
      ? "main"
      : branches.includes("master")
        ? "master"
        : branches[0];

  return { branches, current: "", defaultBase };
}

function fetchRef(repo, ref) {
  const name = String(ref || "").trim();
  if (!name) return;
  try {
    runGit(["rev-parse", "--verify", name], { cwd: repo });
    return;
  } catch {
    /* falta localmente */
  }
  runGit(
    ["fetch", "--depth", DEEPEN_BY, "origin", `refs/heads/${name}:refs/heads/${name}`],
    { cwd: repo },
  );
}

function deepenUntilMergeBase(repo, base, branch) {
  for (let i = 0; i < MAX_DEEPEN_ROUNDS; i++) {
    try {
      git(repo, ["merge-base", base, branch]);
      return;
    } catch {
      runGit(
        [
          "fetch",
          "--deepen",
          DEEPEN_BY,
          "origin",
          `refs/heads/${base}:refs/heads/${base}`,
          `refs/heads/${branch}:refs/heads/${branch}`,
        ],
        { cwd: repo },
      );
    }
  }
  throw new Error(
    `No se encontró merge-base entre "${base}" y "${branch}" (historial shallow insuficiente). Probá con más historia o usá una carpeta local.`,
  );
}

/**
 * Asegura un worktree local (cache en tmp) con branch y base disponibles para diff.
 * @returns {string} ruta absoluta del clone
 */
export function ensureRemoteWorktree(url, branch, base = "develop") {
  const remote = normalizeGitUrl(url);
  const b = String(branch || "").trim();
  const baseRef = String(base || "develop").trim() || "develop";
  if (!b) throw new Error("Falta el branch a revisar.");

  mkdirSync(CACHE_ROOT, { recursive: true });
  const dir = cacheDirFor(remote);
  const gitDir = join(dir, ".git");

	if (!existsSync(gitDir)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		try {
			runGit(
				[
					"clone",
					"--filter=blob:none",
					"--depth",
					DEEPEN_BY,
					"--branch",
					b,
					remote,
					dir,
				],
				{ timeout: 10 * 60 * 1000 },
			);
		} catch (err) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			const stderr = String(/** @type {{ stderr?: string }} */ (err).stderr || err.message || err);
			throw new Error("No se pudo clonar el repo: " + stderr.split("\n").find(Boolean));
		}
	} else {
		try {
			runGit(["remote", "set-url", "origin", remote], { cwd: dir });
		} catch {
			/* remote ya ok */
		}
		fetchRef(dir, b);
		try {
			runGit(["checkout", "--force", b], { cwd: dir });
		} catch {
			/* detached / already on branch */
		}
	}

  if (baseRef !== b) fetchRef(dir, baseRef);
  deepenUntilMergeBase(dir, baseRef, b);
  return dir;
}
