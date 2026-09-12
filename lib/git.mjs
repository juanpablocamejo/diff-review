import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

export function git(repo, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
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

export function fingerprint(branchSha, baseSha) {
  const a = shortSha(branchSha);
  const b = shortSha(baseSha);
  if (!a || !b) return null;
  return `${a}-${b}`;
}

/** File/URL id: short tip of the reviewed branch + short tip of the base. */
export function reportId(branchSha, baseSha) {
  const id = fingerprint(branchSha, baseSha);
  if (!id) throw new Error("Faltan SHAs de los tips para el id del reporte.");
  return id;
}

function shortSha(sha, n = 10) {
  const hex = String(sha || "").toLowerCase().replace(/[^a-f0-9]/g, "");
  return hex.length >= 7 ? hex.slice(0, n) : "";
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
  const raw = git(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  const names = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => name.replace(/^origin\//, ""))
    .filter((name) => name !== "HEAD" && !name.endsWith("/HEAD"));

  // Dedup conservando el orden de for-each-ref (más reciente primero).
  const unique = [...new Set(names)];

  const current = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const bases = unique.filter((n) => n === "develop" || n === "main" || n === "master");
  const defaultBase = bases.includes("develop")
    ? "develop"
    : bases.includes("main")
      ? "main"
      : bases[0] || "develop";

  return { branches: unique, current, defaultBase };
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
