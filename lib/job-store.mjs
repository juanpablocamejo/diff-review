import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHECKPOINT_VERSION = 1;

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function checkpointsDir(dataDir) {
  return join(dataDir, "checkpoints");
}

export function checkpointPath(dataDir, reportId) {
  return join(checkpointsDir(dataDir), `${reportId}.json`);
}

export function skeletonPath(dataDir, reportId) {
  return join(checkpointsDir(dataDir), `${reportId}.skeleton.json`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

/** @param {string} dataDir @param {string} reportId */
export function loadCheckpoint(dataDir, reportId) {
  const path = checkpointPath(dataDir, reportId);
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  if (!raw || raw.version !== CHECKPOINT_VERSION) return null;
  return raw;
}

/** @param {string} dataDir @param {object} state */
export function saveCheckpoint(dataDir, state) {
  ensureDir(checkpointsDir(dataDir));
  const reportId = String(state.reportId || "").trim();
  if (!reportId) return;
  const path = checkpointPath(dataDir, reportId);
  writeJson(path, {
    version: CHECKPOINT_VERSION,
    updatedAt: new Date().toISOString(),
    ...state,
  });
}

/** @param {string} dataDir @param {string} reportId @param {object} skeleton */
export function saveSkeleton(dataDir, reportId, skeleton) {
  ensureDir(checkpointsDir(dataDir));
  writeJson(skeletonPath(dataDir, reportId), skeleton);
}

/** @param {string} dataDir @param {string} reportId */
export function loadSkeleton(dataDir, reportId) {
  const path = skeletonPath(dataDir, reportId);
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  return raw?.branch ? raw : null;
}

/** @param {string} dataDir @param {string} reportId */
export function deleteCheckpoint(dataDir, reportId) {
  const ck = checkpointPath(dataDir, reportId);
  const sk = skeletonPath(dataDir, reportId);
  if (existsSync(ck)) unlinkSync(ck);
  if (existsSync(sk)) unlinkSync(sk);
}

/** @param {string} dataDir */
export function listCheckpoints(dataDir) {
  const dir = checkpointsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".skeleton.json")) continue;
    const raw = readJson(join(dir, name));
    if (!raw?.reportId || raw.done) continue;
    out.push(raw);
  }
  return out;
}

/** Inputs match enough to resume (repo, branch, base, agent). */
export function inputsMatch(saved, input) {
  if (!saved || !input) return false;
  const norm = (v) => String(v || "").trim();
  return (
    norm(saved.repo) === norm(input.repo) &&
    norm(saved.branch) === norm(input.branch) &&
    norm(saved.base) === norm(input.base) &&
    norm(saved.agent) === norm(input.agent)
  );
}
