import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeMs } from "./format.mjs";
import { assertGitRepo, branchTips, fingerprint } from "./git.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function assertReportId(id) {
  const trimmed = String(id || "").trim();
  if (!ID_RE.test(trimmed)) throw new Error("Id de reporte inválido.");
  return trimmed;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function staleFor(json) {
  const repo = json.repo;
  if (!repo) return { stale: null, currentFingerprint: null };
  try {
    assertGitRepo(repo);
    const current = branchTips(repo, json.branch, json.baseBranch || "develop");
    const currentFingerprint = fingerprint(current.branchSha, current.baseSha);
    if (!json.branchSha || !json.baseSha) {
      return { stale: true, currentFingerprint };
    }
    const stale = current.branchSha !== json.branchSha || current.baseSha !== json.baseSha;
    return { stale, currentFingerprint };
  } catch {
    return { stale: null, currentFingerprint: null };
  }
}

export function reportMeta(json, id) {
  const { stale, currentFingerprint } = staleFor(json);
  const storedFp = fingerprint(json.branchSha, json.baseSha);
  const findings = Array.isArray(json.findings) ? json.findings : [];
  return {
    id,
    version: Number(json.version) || 1,
    branch: json.branch,
    baseBranch: json.baseBranch,
    repo: json.repo || null,
    generatedAt: json.generatedAt || null,
    generatedMs: normalizeMs(json.generatedMs),
    timings: json.timings && typeof json.timings === "object" ? json.timings : null,
    intent: json.intent || json.summary || "",
    stats: json.stats || { filesChanged: 0, insertions: 0, deletions: 0 },
    branchSha: json.branchSha || null,
    baseSha: json.baseSha || null,
    fingerprint: storedFp,
    currentFingerprint,
    stale,
    agent: json.agent === "cursor" || json.agent === "claude" || json.agent === "copilot" ? json.agent : null,
    model: json.model || null,
    mergeBase: json.mergeBase || null,
    findings,
    groupCount: Array.isArray(json.groups) ? json.groups.length : 0,
    blockCount: Array.isArray(json.blocks) ? json.blocks.length : 0,
    blockerCount: findings.filter((f) => f.blocking).length,
    qualityCount: findings.filter((f) => f.class === "quality").length,
    ignored: json.stats?.filesIgnored ?? 0,
    truncated: json.stats?.filesTruncated ?? 0,
    promptCount: Array.isArray(json.prompts) ? json.prompts.length : 0,
    notes: Array.isArray(json.notes) ? json.notes : [],
  };
}

export function normalizePrompts(raw) {
  if (!Array.isArray(raw)) return [];
  const steps = new Set(["review", "repair", "batch", "synthesis"]);
  return raw.map((item, i) => ({
    step: steps.has(item?.step) ? item.step : "review",
    label: String(item?.label || `Paso ${i + 1}`),
    prompt: String(item?.prompt || ""),
    chars: Number(item?.chars) || String(item?.prompt || "").length,
    ms: normalizeMs(item?.ms),
    skipped: Boolean(item?.skipped),
    note: item?.note ? String(item.note) : "",
    response: item?.response ? String(item.response) : "",
    responseChars: Number(item?.responseChars) || 0,
    usage:
      item?.usage && typeof item.usage === "object"
        ? {
            inputTokens: Number(item.usage.inputTokens) || 0,
            outputTokens: Number(item.usage.outputTokens) || 0,
            agent: item.usage.agent ? String(item.usage.agent) : undefined,
          }
        : null,
  }));
}

export function normalizeRunLog(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const text = String(item?.text || "").trim();
    if (!text) continue;
    out.push({
      text,
      at: Number(item?.at) || 0,
      stepMs: normalizeMs(item?.stepMs),
      kind: item?.kind === "prompt" || item?.kind === "wait" ? item.kind : undefined,
      promptIndex: Number.isInteger(item?.promptIndex) ? item.promptIndex : undefined,
    });
  }
  return out;
}

export function listSavedReports(dataDir) {
  if (!existsSync(dataDir)) return [];
  const files = readdirSync(dataDir).filter((name) => name.endsWith(".json"));
  const reports = [];
  for (const name of files) {
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    const json = readJson(join(dataDir, name));
    if (!json?.branch) continue;
    reports.push(reportMeta(json, id));
  }
  reports.sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")));
  return reports;
}

export function loadSavedReport(dataDir, outputDir, id) {
  const safeId = assertReportId(id);
  const jsonPath = join(dataDir, `${safeId}.json`);
  if (!existsSync(jsonPath)) throw new Error("No hay un reporte con ese id.");
  const json = readJson(jsonPath);
  if (!json?.branch) throw new Error("El JSON del reporte está incompleto.");
  const htmlPath = join(outputDir, `${safeId}.html`);
  return {
    ...reportMeta(json, safeId),
    // El documento entero: la UI lo renderiza nativo, no hay HTML intermedio.
    document: json,
    prompts: normalizePrompts(json.prompts),
    runLog: normalizeRunLog(json.runLog),
    jsonPath,
    htmlPath: existsSync(htmlPath) ? htmlPath : null,
  };
}
