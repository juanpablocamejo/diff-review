import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export { fingerprint, reportId } from "./fingerprint.mjs";

export function assertGitRepo(repo) {
  const raw = String(repo || "").trim();
  if (!raw) {
    throw new Error("Indicá la ruta absoluta de un repositorio git.");
  }
  if (!/[\\/]/.test(raw) && !/^[A-Za-z]:/.test(raw)) {
    throw new Error(
      `"${raw}" no es una ruta. Pegá la ruta absoluta del repo (ej. C:\\tienda-argenta\\tienda-argenta-2).`,
    );
  }
  const resolved = resolve(raw);
  if (!resolved || resolved === ".") {
    throw new Error("Indicá la ruta absoluta de un repositorio git.");
  }
  if (!existsSync(resolved)) {
    throw new Error(`No existe la carpeta: ${resolved}`);
  }
  if (!existsSync(join(resolved, ".git"))) {
    throw new Error(`No es un repositorio git (falta .git): ${resolved}`);
  }
  return resolved;
}

/**
 * Si `cwd` está dentro de un repo git, devuelve la raíz absoluta; si no, null.
 * Acepta subcarpetas (usa `git rev-parse --show-toplevel`).
 */
export function tryResolveGitRoot(cwd) {
  const raw = String(cwd || "").trim();
  if (!raw) return null;
  const dir = resolve(raw);
  if (!existsSync(dir)) return null;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root ? resolve(root) : null;
  } catch {
    return null;
  }
}

export function git(repo, args, { maxBuffer = 64 * 1024 * 1024, quiet = false } = {}) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
    // Evita `fatal: …` en la terminal cuando el fallo es esperado (repo vacío, etc.).
    ...(quiet ? { stdio: ["ignore", "pipe", "ignore"] } : {}),
  });
}

export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function resolveRev(repo, ref) {
  return git(repo, ["rev-parse", ref]).trim();
}

export function branchTips(repo, branch, base) {
  return {
    branchSha: resolveRev(repo, branch),
    baseSha: resolveRev(repo, base),
  };
}

export function commitLog(repo, mergeBase, branch, limit = 25) {
  try {
    return git(repo, [
      "log",
      "--oneline",
      "--no-merges",
      "-n",
      String(limit),
      `${mergeBase}..${branch}`,
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const FILE_LINE_CACHE = new Map();
const FILE_LINE_CACHE_MAX = 48;

function rememberFileLines(key, lines) {
  if (FILE_LINE_CACHE.has(key)) FILE_LINE_CACHE.delete(key);
  FILE_LINE_CACHE.set(key, lines);
  while (FILE_LINE_CACHE.size > FILE_LINE_CACHE_MAX) {
    const oldest = FILE_LINE_CACHE.keys().next().value;
    FILE_LINE_CACHE.delete(oldest);
  }
}

export function showFileLines(repo, rev, path) {
  const resolved = assertGitRepo(repo);
  const safeRev = String(rev || "").trim();
  const safePath = String(path || "").replace(/\\/g, "/").trim();
  if (!safeRev || !/^[A-Za-z0-9._/\-]+$/.test(safeRev)) {
    throw new Error("Rev inválido.");
  }
  if (!safePath || safePath.startsWith("/") || safePath.includes("..") || safePath.includes("\0")) {
    throw new Error("Ruta inválida.");
  }
  const key = `${resolved}\0${safeRev}\0${safePath}`;
  if (FILE_LINE_CACHE.has(key)) return FILE_LINE_CACHE.get(key);
  let text;
  try {
    text = git(resolved, ["show", `${safeRev}:${safePath}`]);
  } catch {
    rememberFileLines(key, null);
    return null;
  }
  if (text.includes("\0")) {
    rememberFileLines(key, null);
    return null;
  }
  const raw = text.replace(/\r\n/g, "\n");
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  rememberFileLines(key, lines);
  return lines;
}

export function listBranches(repo) {
  let raw = "";
  try {
    raw = git(
      repo,
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ],
      { quiet: true },
    );
  } catch {
    throw new Error(`No es un repositorio git usable: ${repo}`);
  }
  const names = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => name.replace(/^origin\//, ""))
    .filter((name) => name !== "HEAD" && !name.endsWith("/HEAD"));

  // Dedup conservando el orden de for-each-ref (más reciente primero).
  const unique = [...new Set(names)];

  let current;
  try {
    current = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).trim();
  } catch {
    throw new Error("El repositorio no tiene commits (falta HEAD).");
  }
  const bases = unique.filter((n) => n === "develop" || n === "main" || n === "master");
  const defaultBase = bases.includes("develop")
    ? "develop"
    : bases.includes("main")
      ? "main"
      : bases[0] || "develop";

  return { branches: unique, current, defaultBase };
}

function assertBranchName(branch) {
  const name = String(branch || "").trim();
  if (!name || name.startsWith("-") || name.includes("..") || /[\s~^:?*[\]\\]/.test(name)) {
    throw new Error("Nombre de branch inválido.");
  }
  return name;
}

function gitFailure(err) {
  if (err && typeof err === "object") {
    const stderr = String(err.stderr || "")
      .trim()
      .split("\n")
      .find(Boolean);
    if (stderr) return stderr;
    if (err.message) return String(err.message).split("\n")[0];
  }
  return err instanceof Error ? err.message : String(err);
}

export function localBranchExists(repo, branch) {
  const name = String(branch || "").trim();
  if (!name) return false;
  try {
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Upstream de tracking, o `origin/<branch>` si ese remote-tracking existe.
 * @returns {string | null}
 */
export function branchUpstream(repo, branch) {
  const name = String(branch || "").trim();
  if (!name || !localBranchExists(repo, name)) return null;
  try {
    const tracked = git(repo, ["rev-parse", "--abbrev-ref", `${name}@{upstream}`], { quiet: true }).trim();
    if (tracked && !tracked.includes(" ")) return tracked;
  } catch {
    /* sin tracking */
  }
  const remoteRef = `origin/${name}`;
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`], { quiet: true });
    return remoteRef;
  } catch {
    return null;
  }
}

/**
 * Cuántos commits le faltan al branch local respecto de su upstream.
 * @returns {{ branch: string, upstream: string | null, behind: number, local: boolean }}
 */
export function branchBehind(repo, branch) {
  const name = String(branch || "").trim();
  if (!name || !localBranchExists(repo, name)) {
    return { branch: name, upstream: null, behind: 0, local: false };
  }
  const upstream = branchUpstream(repo, name);
  if (!upstream) return { branch: name, upstream: null, behind: 0, local: true };
  let behind = 0;
  try {
    behind = Number(git(repo, ["rev-list", "--count", `${name}..${upstream}`], { quiet: true }).trim()) || 0;
  } catch {
    behind = 0;
  }
  return { branch: name, upstream, behind, local: true };
}

function splitRemoteRef(ref) {
  const i = String(ref || "").indexOf("/");
  if (i <= 0) return null;
  return { remote: ref.slice(0, i), branch: ref.slice(i + 1) };
}

/**
 * Adelanta un branch local con fast-forward. Fetch primero.
 * Si está checked out y el worktree está sucio, no toca nada.
 * Si no está checked out, actualiza la ref con `git fetch <remote> <branch>:<branch>` (no hace checkout).
 * @returns {{ branch: string, upstream: string | null, behind: number, local: boolean }}
 */
export function fastForwardBranch(repo, branch) {
  const name = assertBranchName(branch);
  if (!localBranchExists(repo, name)) {
    throw new Error(`\`${name}\` no es un branch local. No actualicé nada.`);
  }

  let upstream = branchUpstream(repo, name);
  const remote = splitRemoteRef(upstream || `origin/${name}`);
  if (!remote) {
    throw new Error(`\`${name}\` no tiene un upstream reconocible. No actualicé nada.`);
  }

  try {
    git(repo, ["fetch", remote.remote]);
  } catch (err) {
    throw new Error(
      `No pude hacer fetch de \`${remote.remote}\` (${gitFailure(err)}). No se modificó el branch.`,
    );
  }

  upstream = branchUpstream(repo, name);
  const resolved = splitRemoteRef(upstream || "");
  if (!upstream || !resolved) {
    throw new Error(
      `Después del fetch, \`${name}\` sigue sin upstream (ni ${remote.remote}/${name}). No se modificó el branch.`,
    );
  }

  let head = "";
  try {
    head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).trim();
  } catch {
    head = "";
  }
  const checkedOut = head === name;

  if (checkedOut) {
    let dirty = "";
    try {
      dirty = git(repo, ["status", "--porcelain"], { quiet: true }).trim();
    } catch (err) {
      throw new Error(`No pude leer el estado del worktree (${gitFailure(err)}). No se modificó el branch.`);
    }
    if (dirty) {
      throw new Error(
        `No actualicé \`${name}\`: el working tree tiene cambios sin commitear. Guardalos o stashealos y reintentá. No se descartó nada.`,
      );
    }
    try {
      git(repo, ["merge", "--ff-only", upstream]);
    } catch (err) {
      throw new Error(
        `No pude adelantar \`${name}\` a \`${upstream}\` (solo fast-forward: ${gitFailure(err)}). No se descartó nada.`,
      );
    }
  } else {
    try {
      git(repo, ["fetch", resolved.remote, `${resolved.branch}:${name}`]);
    } catch (err) {
      throw new Error(
        `No pude adelantar \`${name}\` sin hacer checkout (fast-forward imposible: ${gitFailure(err)}). No se descartó nada.`,
      );
    }
  }

  return branchBehind(repo, name);
}

/** URL del remote (origin, o el primero disponible). Vacío si no hay. */
export function getRemoteUrl(repo, preferred = "origin") {
  try {
    const url = git(repo, ["remote", "get-url", preferred]).trim();
    if (url) return url;
  } catch {
    /* sin origin */
  }
  try {
    const remotes = git(repo, ["remote"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!remotes.length) return "";
    return git(repo, ["remote", "get-url", remotes[0]]).trim();
  } catch {
    return "";
  }
}
