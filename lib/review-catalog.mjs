/**
 * El catálogo de reportes son los JSON en `.diff-review/` (y los nombres viejos en la raíz).
 * El id de `/report/<id>` es `meta.viewerId`: el nombre del archivo puede cambiar y el link sigue.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { decodePayload } from "./json-payload.mjs";
import { isOutputFilename } from "./output-name.mjs";
import { companionPaths, ensureReviewDir, locateReviewFile, reviewDir } from "./review-dir.mjs";

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asMeta(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const current = payload.meta;
  if (current && typeof current === "object" && !Array.isArray(current)) return current;
  return {};
}

/** @param {unknown} payload */
export function viewerIdOf(payload) {
  const meta = asMeta(payload);
  if (!meta) return "";
  return str(meta.viewerId);
}

function readPayload(filePath) {
  try {
    const payload = decodePayload(readFileSync(filePath, "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

function writePayload(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Escribe `meta.viewerId` si falta. Si el archivo ya tiene uno, no lo pisa.
 * @param {string} filePath
 * @param {string} [preferred] UUID ya asociado (p. ej. el del índice viejo)
 * @returns {string}
 */
export function stampViewerId(filePath, preferred = "") {
  const payload = readPayload(filePath);
  if (!payload) return "";
  const existing = viewerIdOf(payload);
  if (existing) return existing;
  const id = str(preferred) || randomUUID();
  const meta = asMeta(payload) || {};
  payload.meta = { ...meta, viewerId: id };
  writePayload(filePath, payload);
  return id;
}

/**
 * @param {string} dir
 * @param {"dir" | "root"} location
 */
function listJson(dir, location) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {{ name: string, fullPath: string, location: "dir" | "root", mtimeMs: number }[]} */
  const out = [];
  for (const name of names) {
    if (!isOutputFilename(name)) continue;
    const fullPath = join(dir, name);
    try {
      const st = statSync(fullPath);
      if (!st.isFile()) continue;
      out.push({ name, fullPath, location, mtimeMs: st.mtimeMs });
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** JSON de review en `.diff-review/` y, si no está duplicado ahí, en la raíz. */
export function collectReviewJson(repoRoot) {
  const root = resolve(String(repoRoot || ""));
  return [...listJson(reviewDir(root), "dir"), ...listJson(root, "root")];
}

function findingOpen(finding) {
  const kind =
    finding && finding.resolution && typeof finding.resolution === "object" ? finding.resolution.kind : "";
  return kind !== "corrected" && kind !== "ignored";
}

function savedAtOf(payload, mtimeMs) {
  const meta = asMeta(payload) || {};
  const generated = str(meta.generatedAt);
  if (generated && !Number.isNaN(Date.parse(generated))) return new Date(generated).toISOString();
  return new Date(mtimeMs).toISOString();
}

function summarize(entry, repo) {
  const payload = entry.payload;
  const meta = asMeta(payload) || {};
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const open = findings.filter(findingOpen);
  const agent = str(meta.agent);
  const model = str(meta.modelLabel) || str(meta.model);
  return {
    id: entry.viewerId,
    repo,
    branch: str(meta.branch),
    base: str(meta.base) || "develop",
    savedAt: savedAtOf(payload, entry.file.mtimeMs),
    groupCount: Array.isArray(payload.groups) ? payload.groups.length : 0,
    blockerCount: open.filter((f) => f && f.blocking === true).length,
    qualityCount: open.filter((f) => f && f.class === "quality").length,
    intent: str(payload.intent),
    outputFilename: entry.file.name,
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  };
}

function hintMap(hints) {
  const byName = new Map();
  for (const hint of hints || []) {
    const name = basename(str(hint?.filename));
    const id = str(hint?.viewerId);
    if (!name || !id || !isOutputFilename(name) || byName.has(name)) continue;
    byName.set(name, id);
  }
  return byName;
}

function readEntry(file) {
  const payload = readPayload(file.fullPath);
  if (!payload) return null;
  return { file, payload, viewerId: viewerIdOf(payload) };
}

/**
 * Una tarjeta por `viewerId`. Estampa el id si falta (hint del localStorage, si no uno nuevo).
 * @param {string} repoRoot
 * @param {{ filename?: string, viewerId?: string }[]} [hints]
 */
export function listReviewCatalog(repoRoot, hints = []) {
  const root = resolve(String(repoRoot || ""));
  const hintsByName = hintMap(hints);
  const entries = collectReviewJson(root).map(readEntry).filter(Boolean);
  const dirByName = new Map(entries.filter((e) => e.file.location === "dir").map((e) => [e.file.name, e]));
  const visible = [];
  for (const entry of entries) {
    if (entry.file.location === "root") {
      const dir = dirByName.get(entry.file.name);
      if (dir) {
        const rootId = entry.viewerId;
        const dirId = dir.viewerId;
        // La copia de la raíz es el mismo reporte salvo que ya tenga otro viewerId.
        if (!rootId || !dirId || rootId === dirId) continue;
      }
    }
    visible.push(entry);
  }

  /** @type {typeof visible} */
  const stamped = [];
  for (const entry of visible) {
    if (entry.viewerId) {
      stamped.push(entry);
      continue;
    }
    let id = "";
    try {
      id = stampViewerId(entry.file.fullPath, hintsByName.get(entry.file.name) || "");
    } catch {
      continue;
    }
    if (!id) continue;
    const payload = readPayload(entry.file.fullPath) || entry.payload;
    stamped.push({ ...entry, payload, viewerId: id });
  }

  stamped.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
  const seen = new Set();
  const out = [];
  for (const entry of stamped) {
    if (!entry.viewerId || seen.has(entry.viewerId)) continue;
    seen.add(entry.viewerId);
    out.push(summarize(entry, root));
  }
  return out;
}

/**
 * Busca por `meta.viewerId` y, si no, por nombre de archivo. Solo estampa el archivo encontrado.
 * @param {string} repoRoot
 * @param {{ viewerId?: string, filename?: string }} query
 */
export function findReviewInRepo(repoRoot, query = {}) {
  const root = resolve(String(repoRoot || ""));
  const wantId = str(query.viewerId);
  const wantName = basename(str(query.filename));
  const wantNameIsFile = wantName && isOutputFilename(wantName) ? wantName : "";
  const idAsName = wantId && isOutputFilename(wantId) ? wantId : "";
  /** @type {{ file: { name: string, fullPath: string, location: "dir" | "root", mtimeMs: number }, payload: Record<string, unknown> } | null} */
  let byName = null;
  for (const file of collectReviewJson(root)) {
    const payload = readPayload(file.fullPath);
    if (!payload) continue;
    const id = viewerIdOf(payload);
    if (wantId && id && id === wantId) {
      return { filename: file.name, payload, viewerId: id, location: file.location };
    }
    const nameHit = (wantNameIsFile && file.name === wantNameIsFile) || (idAsName && file.name === idAsName);
    if (nameHit && !byName) byName = { file, payload };
  }
  if (!byName) return null;
  const id = stampViewerId(byName.file.fullPath, wantId);
  if (!id) return null;
  const payload = readPayload(byName.file.fullPath) || byName.payload;
  return { filename: byName.file.name, payload, viewerId: id, location: byName.file.location };
}

function containedPath(root, name, full) {
  if (!isOutputFilename(name)) return false;
  return full === resolve(reviewDir(root), name) || full === resolve(root, name);
}

/**
 * Borra el JSON nombrado (`.diff-review/` o la raíz) y otras copias con el mismo `viewerId`.
 * El nombre tiene que pasar la allowlist; no sigue `..`.
 * @param {string} repoRoot
 * @param {string} filename
 * @param {string} [viewerId]
 * @returns {boolean}
 */
export function deleteReviewJson(repoRoot, filename, viewerId = "") {
  const name = basename(str(filename));
  if (!name || !isOutputFilename(name)) {
    throw new Error("Nombre de archivo inválido.");
  }
  const root = resolve(String(repoRoot || ""));
  const id = str(viewerId);
  let deleted = false;
  for (const file of collectReviewJson(root)) {
    const full = resolve(file.fullPath);
    if (!containedPath(root, file.name, full)) continue;
    const payloadId = viewerIdOf(readPayload(file.fullPath));
    const named = file.name === name;
    const sameIdentity = Boolean(id) && payloadId === id;
    if (!named && !sameIdentity) continue;
    if (named && id && payloadId && payloadId !== id) continue;
    unlinkSync(full);
    deleted = true;
  }
  return deleted;
}

/**
 * Migración: si el archivo existe, estampa `viewerId` (sin pisar uno ya puesto).
 * Si no existe y hay payload, lo escribe en `.diff-review/<nombre>.json`.
 * @param {string} repoRoot
 * @param {{ filename?: string, viewerId?: string, payload?: unknown }} item
 */
export function adoptReviewFile(repoRoot, item) {
  const name = basename(str(item?.filename));
  const requested = str(item?.viewerId);
  if (!name || !isOutputFilename(name) || !requested) {
    return { filename: name, viewerId: requested, status: "missing" };
  }
  const root = resolve(String(repoRoot || ""));
  const existing = locateReviewFile(root, name);
  if (existing) {
    const before = viewerIdOf(readPayload(existing));
    const id = stampViewerId(existing, requested);
    if (!id) return { filename: name, viewerId: requested, status: "missing" };
    return { filename: name, viewerId: id, status: before ? "kept" : "stamped" };
  }
  const payload = item?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { filename: name, viewerId: requested, status: "missing" };
  }
  ensureReviewDir(root);
  const meta = asMeta(payload) || {};
  const id = str(meta.viewerId) || requested;
  writePayload(companionPaths(root, name).json, { ...payload, meta: { ...meta, viewerId: id } });
  return { filename: name, viewerId: id, status: "written" };
}

/**
 * @param {string} repoRoot
 * @param {string} filename
 * @param {string} [preferred]
 * @returns {{ filename: string, viewerId: string } | null}
 */
export function ensureFileViewerId(repoRoot, filename, preferred = "") {
  const name = basename(str(filename));
  if (!name || !isOutputFilename(name)) return null;
  const path = locateReviewFile(resolve(String(repoRoot || "")), name);
  if (!path) return null;
  const id = stampViewerId(path, preferred);
  if (!id) return null;
  return { filename: name, viewerId: id };
}
