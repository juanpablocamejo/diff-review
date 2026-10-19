/**
 * Caché en disco de las listas de modelos ACP por agente.
 * TTL 24h: los catálogos cambian de a poco (semanas); un día evita spawnear el CLI en cada review
 * y sigue fresco si aparece un modelo nuevo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 24 horas. */
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** @returns {string} */
export function modelsCachePath(home = homedir()) {
  return join(home, ".diff-review", "models-cache.json");
}

/**
 * @param {string} agentId
 * @param {{ home?: string, now?: number, ttlMs?: number }} [opts]
 * @returns {{ models: { value: string, name: string }[], currentModel: string, fetchedAt: string } | null}
 */
export function readModelsCache(agentId, opts = {}) {
  const id = String(agentId || "").trim();
  if (!id) return null;
  const path = modelsCachePath(opts.home);
  let root;
  try {
    root = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const entry = root?.agents?.[id];
  if (!entry || !Array.isArray(entry.models)) return null;
  const fetchedAt = Date.parse(String(entry.fetchedAt || ""));
  if (!Number.isFinite(fetchedAt)) return null;
  const ttl = opts.ttlMs ?? MODELS_CACHE_TTL_MS;
  const now = opts.now ?? Date.now();
  if (now - fetchedAt > ttl) return null;
  return {
    models: entry.models
      .filter((m) => m && typeof m.value === "string")
      .map((m) => ({ value: m.value, name: String(m.name ?? m.value) })),
    currentModel: String(entry.currentModel ?? ""),
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
}

/**
 * @param {string} agentId
 * @param {{ models: { value: string, name: string }[], currentModel?: string }} data
 * @param {{ home?: string, now?: number }} [opts]
 */
export function writeModelsCache(agentId, data, opts = {}) {
  const id = String(agentId || "").trim();
  if (!id || !Array.isArray(data?.models) || !data.models.length) return;
  const path = modelsCachePath(opts.home);
  let root = { version: 1, agents: {} };
  try {
    if (existsSync(path)) root = { ...root, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    /* archivo nuevo */
  }
  if (!root.agents || typeof root.agents !== "object") root.agents = {};
  root.agents[id] = {
    fetchedAt: new Date(opts.now ?? Date.now()).toISOString(),
    currentModel: String(data.currentModel ?? ""),
    models: data.models.map((m) => ({
      value: String(m.value),
      name: String(m.name ?? m.value),
    })),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
}
