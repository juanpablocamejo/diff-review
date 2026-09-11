import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_IGNORE = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/*.g.cs",
  "**/*Snapshot.cs",
  "**/*.Designer.cs",
  "**/node_modules/**",
  "**/.svelte-kit/**",
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/CODE_REVIEW_CORRECTNESS_FINDINGS.md",
];

export const STORE_DIFF_MAX = 400_000;
/** Pack prompts so a single CLI turn stays inside a typical Pro context window. Files are not truncated to fit. */
export const PROMPT_BATCH_CHARS = 200_000;
export const PROMPT_BATCH_FILES = 16;
/** Independent judge: drop findings scored below this (Claude code-review uses 80). */
export const JUDGE_MIN_SCORE = 80;
export const GUIDELINE_FILES = ["REVIEW.md", "CLAUDE.md", "AGENTS.md"];

function unquote(s) {
  const t = String(s || "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Minimal YAML: `key: value` and `key:\n  - item`. */
export function parseSimpleYaml(text) {
  const result = {};
  let key = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const list = raw.match(/^\s+-\s+(.*)$/);
    if (list && key) {
      if (!Array.isArray(result[key])) result[key] = [];
      result[key].push(unquote(list[1]));
      continue;
    }
    const kv = raw.match(/^([A-Za-z][\w]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    result[key] = v === "" ? [] : unquote(v);
  }
  return result;
}

export function globToRegExp(glob) {
  let g = String(glob || "").replace(/\\/g, "/");
  if (!g.includes("/")) g = `**/${g}`;
  let s = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        s += "(?:.*/)?";
        i += 2;
      } else {
        s += ".*";
        i += 1;
      }
    } else if (c === "*") s += "[^/]*";
    else if (c === "?") s += "[^/]";
    else if ("+()[]{}|.^$".includes(c)) s += `\\${c}`;
    else s += c;
  }
  return new RegExp(`^${s}$`, "i");
}

export function globMatch(filePath, pattern) {
  const norm = String(filePath || "").replace(/\\/g, "/");
  return globToRegExp(pattern).test(norm);
}

export function isIgnored(filePath, patterns) {
  return (patterns || []).some((p) => globMatch(filePath, p));
}

export function isTestPath(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/");
  return /(^|\/)(__tests__|tests?|spec)s?(\/|$)/i.test(p) || /\.(test|spec)\.[^.]+$/i.test(p);
}

function readIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function loadReviewConfig(repo) {
  const jsonText = readIfExists(join(repo, ".diff-review.json"));
  const yamlText =
    readIfExists(join(repo, ".diff-review.yml")) || readIfExists(join(repo, ".diff-review.yaml"));
  let extra = {};
  if (jsonText) {
    try {
      extra = JSON.parse(jsonText);
    } catch {
      extra = {};
    }
  } else if (yamlText) {
    extra = parseSimpleYaml(yamlText);
  }

  const extraIgnore = Array.isArray(extra.ignore) ? extra.ignore.map(String) : [];
  const rulesFile = extra.rulesFile ? String(extra.rulesFile) : "REVIEW.md";
  const rules = readIfExists(join(repo, rulesFile)) || "";
  const model = extra.model && extra.model !== "default" ? String(extra.model) : null;

  return {
    ignore: [...DEFAULT_IGNORE, ...extraIgnore],
    model,
    rulesFile,
    rules: rules.trim(),
  };
}

/** CLAUDE.md / REVIEW.md / AGENTS.md from repo root and immediate parent dirs of touched files. */
export function collectGuidelines(
  repo,
  filePaths,
  {
    rulesFile = "REVIEW.md",
    maxChars = 8_000,
    maxTotalChars = 12_000,
    maxDepth = 1,
    skipNames = [],
  } = {},
) {
  const skip = new Set(skipNames);
  const names = [...new Set([rulesFile, ...GUIDELINE_FILES])].filter((name) => !skip.has(name));
  const seen = new Set();
  const out = [];
  const addRel = (rel) => {
    const norm = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!norm || seen.has(norm)) return;
    const abs = join(repo, ...norm.split("/"));
    const text = readIfExists(abs);
    if (!text || !text.trim()) return;
    seen.add(norm);
    out.push({ path: norm, text: text.trim() });
  };
  for (const name of names) addRel(name);
  const depth = Math.max(1, Number(maxDepth) || 1);
  for (const filePath of filePaths || []) {
    const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const minLen = Math.max(1, parts.length - depth);
    for (let len = parts.length - 1; len >= minLen; len--) {
      const dir = parts.slice(0, len).join("/");
      for (const name of names) addRel(`${dir}/${name}`);
    }
  }
  let total = 0;
  const capped = [];
  for (const item of out) {
    if (total >= maxTotalChars) break;
    const room = maxTotalChars - total;
    const slice = item.text.slice(0, Math.min(maxChars, room));
    if (!slice) continue;
    capped.push({ path: item.path, text: slice });
    total += slice.length;
  }
  return capped;
}

export function formatGuidelines(guidelines) {
  if (!Array.isArray(guidelines) || !guidelines.length) return "";
  return `\nGuidelines del repo (aplicá las que correspondan a los archivos tocados; no todas valen en una review):\n${guidelines
    .map((g) => `--- ${g.path} ---\n${g.text}`)
    .join("\n\n")}\n`;
}

export function capDiff(diff, max = STORE_DIFF_MAX) {
  const text = String(diff || "");
  if (text.length <= max) {
    return { diff: text, diffChars: text.length, truncated: false };
  }
  return {
    diff: `${text.slice(0, max)}\n\n… [diff recortado: se guardan ${max} de ${text.length} caracteres]`,
    diffChars: text.length,
    truncated: true,
  };
}

/** Drop unified-diff context lines so the model mostly sees @@ / + / -. */
export function compactDiff(diff) {
  return String(diff || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(" "))
    .join("\n");
}

export function hunkHeaders(diff, limit = 10) {
  const out = [];
  for (const line of String(diff || "").split("\n")) {
    if (!line.startsWith("@@")) continue;
    out.push(line.trim().slice(0, 140));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Model-facing diff: send the stored unified diff as-is, including context lines.
 * Only clips if a single file exceeds `max` (safety for generated dumps that slipped ignore).
 */
export function modelSlice(diff, max = STORE_DIFF_MAX) {
  const raw = String(diff || "");
  if (raw.length <= max) {
    return { diff: raw, modelChars: raw.length, modelTruncated: false };
  }
  const note = `\n\n… [el modelo no vio el resto: ${raw.length} chars en el archivo]`;
  const clipped = raw.slice(0, Math.max(0, max - note.length));
  return {
    diff: clipped + note,
    modelChars: clipped.length,
    modelTruncated: true,
  };
}
