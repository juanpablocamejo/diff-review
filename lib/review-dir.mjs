/**
 * Carpeta `.diff-review/` en la raíz del repo revisado: el JSON del reporte, el diff con el que se hizo y la sesión
 * del agente, todo con el mismo nombre base (`diff-rev_<branchTip>_<baseTip>`). Se ignora sola con su propio
 * `.gitignore`, así no deja cambios en archivos trackeados del repo.
 *
 * Los JSON viejos en la raíz del repo se siguen encontrando (`locateReviewFile`).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { git } from "./git.mjs";
import { OUTPUT_DIR } from "./output-name.mjs";

export { OUTPUT_DIR };

/** @typedef {{ agentId: string, sessionId: string, model?: string, updatedAt?: string }} SessionRef */

export function reviewDir(repoRoot) {
  return join(repoRoot, OUTPUT_DIR);
}

/** Crea `.diff-review/` (con su `.gitignore`) si no existe. */
export function ensureReviewDir(repoRoot) {
  const dir = reviewDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# Generado por diff-review: nada de esta carpeta va al repo.\n*\n");
  return dir;
}

/** `diff-rev_a_b.json` → `{ json, diff, session, chat }` dentro de `.diff-review/`. */
export function companionPaths(repoRoot, filename) {
  const name = basename(String(filename || ""));
  const stem = name.replace(/\.json$/i, "");
  const dir = reviewDir(repoRoot);
  return {
    json: join(dir, name),
    diff: join(dir, `${stem}.diff`),
    session: join(dir, `${stem}.session.json`),
    /** Transcript legible al cambiar de agente (se pisa en cada switch). */
    chat: join(dir, `${stem}.chat.md`),
  };
}

/** Dónde está el JSON de la review: `.diff-review/` primero y, si no, la raíz del repo (formato viejo). */
export function locateReviewFile(repoRoot, filename) {
  const name = basename(String(filename || ""));
  if (!name) return null;
  for (const candidate of [companionPaths(repoRoot, name).json, join(repoRoot, name)]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* siguiente */
    }
  }
  return null;
}

/**
 * Guarda `git diff base...branch` junto al JSON (una vez por par de commits: el nombre ya trae los tips).
 * @returns {string | null} el path, o null si git falló
 */
export function writeDiffCache(repoRoot, filename, { branch, base }) {
  const { diff } = companionPaths(repoRoot, filename);
  if (existsSync(diff)) return diff;
  try {
    const text = git(repoRoot, ["diff", `${base}...${branch}`]);
    ensureReviewDir(repoRoot);
    writeFileSync(diff, text);
    return diff;
  } catch {
    return null;
  }
}

/** Guarda un diff ya armado (p. ej. el que muestra la web), pisando el anterior. */
export function writeDiffText(repoRoot, filename, text) {
  ensureReviewDir(repoRoot);
  const { diff } = companionPaths(repoRoot, filename);
  writeFileSync(diff, String(text ?? ""));
  return diff;
}

/** @returns {string | null} texto del companion `.diff`, o null si no existe / no se pudo leer */
export function readDiffCache(repoRoot, filename) {
  const { diff } = companionPaths(repoRoot, filename);
  try {
    if (!existsSync(diff)) return null;
    return readFileSync(diff, "utf8");
  } catch {
    return null;
  }
}

/** @returns {SessionRef | null} */
export function readSessionRef(repoRoot, filename) {
  try {
    const ref = JSON.parse(readFileSync(companionPaths(repoRoot, filename).session, "utf8"));
    return ref && typeof ref.agentId === "string" && typeof ref.sessionId === "string" ? ref : null;
  } catch {
    return null;
  }
}

/** @param {SessionRef} ref */
export function writeSessionRef(repoRoot, filename, ref) {
  ensureReviewDir(repoRoot);
  const full = { ...ref, updatedAt: new Date().toISOString() };
  writeFileSync(companionPaths(repoRoot, filename).session, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

/**
 * Guarda (pisa) el transcript legible de handoff junto al JSON.
 * @returns {string} path absoluto del `.chat.md`
 */
export function writeHandoffChat(repoRoot, filename, text) {
  ensureReviewDir(repoRoot);
  const { chat } = companionPaths(repoRoot, filename);
  writeFileSync(chat, String(text ?? ""));
  return chat;
}
