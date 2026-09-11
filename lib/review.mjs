import {
  BLOCK_OPS,
  FINDING_CLASSES,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  GROUP_KINDS,
  SKIP_REASONS,
  WHY_SOURCES,
} from "./validate.mjs";

const MAX = {
  intent: 700,
  groupTitle: 100,
  groupIntent: 300,
  what: 240,
  why: 240,
  finding: 360,
};

function text(value, max) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw;
}

function oneOf(value, allowed, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  return allowed.includes(raw) ? raw : fallback;
}

/**
 * Rango de líneas de un bloque. `L40-58` es post-imagen (lo que quedó);
 * `-L88-95` es pre-imagen, que es la única forma de señalar líneas borradas.
 */
export function parseLineRange(value) {
  const raw = String(value ?? "").trim();
  const match = /^(-)?L?(\d+)(?:\s*[-–]\s*L?(\d+))?$/i.exec(raw);
  if (!match) return null;
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  return {
    side: match[1] ? "old" : "new",
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

export function formatLineRange(range) {
  if (!range) return "";
  const prefix = range.side === "old" ? "-L" : "L";
  return range.start === range.end ? `${prefix}${range.start}` : `${prefix}${range.start}-${range.end}`;
}

export function countHunks(files) {
  let total = 0;
  for (const file of files || []) {
    for (const line of String(file.diff || "").split("\n")) {
      if (line.startsWith("@@")) total += 1;
    }
  }
  return total;
}

function normalizeGroups(raw) {
  const seen = new Set();
  const groups = [];
  for (const item of raw || []) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    groups.push({
      id,
      kind: oneOf(item.kind, GROUP_KINDS, "chore"),
      title: text(item.title, MAX.groupTitle) || `${oneOf(item.kind, GROUP_KINDS, "chore")}: cambios`,
      intent: text(item.intent, MAX.groupIntent),
    });
  }
  return groups;
}

function normalizeBlocks(raw, { groupIds, knownPaths }) {
  const seen = new Set();
  const blocks = [];
  for (const item of raw || []) {
    const id = String(item?.id || "").trim();
    const group = String(item?.group || "").trim();
    const file = String(item?.file || "").trim();
    if (!id || seen.has(id)) continue;
    if (!groupIds.has(group)) continue;
    if (knownPaths.size && !knownPaths.has(file)) continue;
    const range = parseLineRange(item.lines);
    seen.add(id);
    blocks.push({
      id,
      group,
      file,
      lines: range ? formatLineRange(range) : text(item.lines, 24),
      side: range?.side || "new",
      start: range?.start ?? 0,
      end: range?.end ?? 0,
      op: oneOf(item.op, BLOCK_OPS, "mod"),
      what: text(item.what, MAX.what),
      why: text(item.why, MAX.why),
      source: oneOf(item.source, WHY_SOURCES, "inferred"),
    });
  }
  blocks.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  return blocks;
}

function findingKey(finding) {
  return [finding.file, finding.line ?? "", finding.kind, finding.what].join("|");
}

function normalizeFindings(raw, { blockIds, knownPaths }) {
  const seen = new Set();
  const findings = [];
  for (const item of raw || []) {
    const file = String(item?.file || item?.path || "").trim();
    const what = text(item?.what || item?.title, MAX.finding);
    if (!file || !what) continue;
    if (knownPaths.size && !knownPaths.has(file)) continue;
    const cls = oneOf(item.class, FINDING_CLASSES, "risk");
    const severity = oneOf(item.severity, FINDING_SEVERITIES, "med");
    const block = String(item?.block || "").trim();
    const line = Number.isFinite(Number(item?.line)) ? Number(item.line) : null;
    const finding = {
      id: "",
      class: cls,
      severity,
      // Una mejora de calidad nunca frena un merge, diga lo que diga el modelo;
      // un riesgo alto sí, aunque el modelo se haya olvidado de marcarlo.
      blocking: cls === "risk" && (item?.blocking === true || severity === "high"),
      kind: oneOf(item.kind, FINDING_KINDS, "other"),
      file,
      line,
      block: blockIds.has(block) ? block : "",
      what,
      fix: text(item.fix || item.detail, MAX.finding),
    };
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }
  const rank = { high: 0, med: 1, low: 2, nit: 3 };
  findings.sort(
    (a, b) =>
      Number(b.blocking) - Number(a.blocking) ||
      (a.class === b.class ? 0 : a.class === "risk" ? -1 : 1) ||
      rank[a.severity] - rank[b.severity] ||
      a.file.localeCompare(b.file),
  );
  findings.forEach((finding, i) => {
    finding.id = `f${i + 1}`;
  });
  return findings;
}

function normalizeSkipped(raw, ignored) {
  const byFile = new Map();
  for (const path of ignored || []) {
    byFile.set(String(path), { file: String(path), reason: "ignored" });
  }
  for (const item of raw || []) {
    const file = String(item?.file || "").trim();
    if (!file) continue;
    byFile.set(file, { file, reason: oneOf(item.reason, SKIP_REASONS, "trivial") });
  }
  return [...byFile.values()];
}

/** Tema donde se dibuja el archivo: el que aporta más bloques, desempatando por orden de tema. */
export function dominantGroup(blocks, path, groupOrder) {
  const tally = new Map();
  for (const block of blocks) {
    if (block.file !== path) continue;
    tally.set(block.group, (tally.get(block.group) || 0) + 1);
  }
  if (!tally.size) return "";
  return [...tally.entries()].sort(
    (a, b) => b[1] - a[1] || groupOrder.indexOf(a[0]) - groupOrder.indexOf(b[0]),
  )[0][0];
}

/** Junta varias respuestas parciales cuando el diff no entró en un solo turno. */
export function mergeReviewPayloads(payloads) {
  const merged = { intent: "", groups: [], blocks: [], findings: [], skipped: [] };
  for (const payload of payloads || []) {
    if (!payload) continue;
    if (!merged.intent && payload.intent) merged.intent = payload.intent;
    for (const key of ["groups", "blocks", "findings", "skipped"]) {
      if (Array.isArray(payload[key])) merged[key].push(...payload[key]);
    }
  }
  return merged;
}

/** Aplica síntesis post-batches: nuevo intent/groups y remap de group en blocks. */
export function applySynthesis(merged, synthesis) {
  if (!merged || !synthesis) return merged;
  const groupMap = synthesis.groupMap && typeof synthesis.groupMap === "object" ? synthesis.groupMap : {};
  const mapGroup = (id) => {
    const key = String(id || "").trim();
    if (!key) return key;
    return String(groupMap[key] || key).trim() || key;
  };
  const blocks = (merged.blocks || []).map((block) => ({
    ...block,
    group: mapGroup(block.group),
  }));
  return {
    ...merged,
    intent: synthesis.intent || merged.intent,
    groups: synthesis.groups || merged.groups,
    blocks,
    findings: merged.findings,
    skipped: merged.skipped,
  };
}

/**
 * Documento final: lo que dijo el modelo, saneado y cruzado contra los archivos
 * reales del diff. Todo lo que no cierra se descarta acá en vez de romper la UI.
 */
export function buildReview({ skeleton, payload, notes = [] }) {
  const files = skeleton.files || [];
  const knownPaths = new Set(files.map((f) => f.path));

  const groups = normalizeGroups(payload?.groups);
  const groupIds = new Set(groups.map((g) => g.id));
  const blocks = normalizeBlocks(payload?.blocks, { groupIds, knownPaths });
  const blockIds = new Set(blocks.map((b) => b.id));
  const findings = normalizeFindings(payload?.findings, { blockIds, knownPaths });
  const skipped = normalizeSkipped(payload?.skipped, skeleton.context?.ignored);

  const usedGroups = new Set(blocks.map((b) => b.group));
  const liveGroups = groups.filter((g) => usedGroups.has(g.id));
  const groupOrder = liveGroups.map((g) => g.id);

  const skippedFiles = new Set(skipped.map((s) => s.file));
  const orphans = files.filter((f) => !blocks.some((b) => b.file === f.path) && !skippedFiles.has(f.path));
  if (orphans.length) {
    notes = [...notes, `${orphans.length} archivo(s) quedaron sin explicación del modelo.`];
  }

  const decorated = files.map((file) => ({
    ...file,
    group: dominantGroup(blocks, file.path, groupOrder),
  }));

  return {
    ...skeleton,
    version: 2,
    intent: text(payload?.intent, MAX.intent),
    groups: liveGroups,
    blocks,
    findings,
    skipped,
    files: decorated,
    stats: { ...skeleton.stats, hunks: countHunks(files) },
    notes,
    generatedAt: new Date().toISOString(),
  };
}
