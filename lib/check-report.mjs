/**
 * Valida un JSON de review y arma un texto accionable para el agente.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { globMatch } from "./config.mjs";
import { extractBranchDiff } from "./extract.mjs";
import { tryResolveGitRoot } from "./git.mjs";
import { decodePayload } from "./json-payload.mjs";
import { REVIEW_SCHEMA, reviewIssues, validateAgainst } from "./validate.mjs";

const MISSING_LIMIT = 40;

/**
 * @param {unknown} payload
 * @param {string[]} [paths] rutas del diff (sin ignorados)
 * @returns {{ ok: boolean, errors: string[], notes: string[] }}
 */
export function checkPayload(payload, paths = []) {
  const errors = [...validateAgainst(REVIEW_SCHEMA, payload), ...reviewIssues(payload)];
  const notes = [];
  const known = (paths || []).map((p) => String(p || "").replaceAll("\\", "/")).filter(Boolean);

  if (known.length) {
    const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
    const findings = Array.isArray(payload?.findings) ? payload.findings : [];
    const skipped = Array.isArray(payload?.skipped) ? payload.skipped : [];
    const skippedPatterns = skipped.map((s) => String(s?.file || "")).filter(Boolean);

    const covers = (file) => {
      const norm = String(file || "").replaceAll("\\", "/");
      if (blocks.some((b) => String(b?.file || "").replaceAll("\\", "/") === norm)) return true;
      return skippedPatterns.some((pattern) => {
        const p = pattern.replaceAll("\\", "/");
        return p === norm || globMatch(norm, p);
      });
    };

    for (const block of blocks) {
      const file = String(block?.file || "").replaceAll("\\", "/");
      if (file && !known.includes(file)) {
        errors.push(`el bloque ${block.id || file} apunta a un archivo que no está en el diff: ${file}`);
      }
    }
    for (const finding of findings) {
      const file = String(finding?.file || "").replaceAll("\\", "/");
      if (file && !known.includes(file)) {
        errors.push(
          `el hallazgo ${finding.id || finding.what || file} apunta a un archivo fuera del diff: ${file}`
        );
      }
    }

    const missing = known.filter((file) => !covers(file));
    if (missing.length) {
      const shown = missing.slice(0, MISSING_LIMIT);
      const rest = missing.length - shown.length;
      errors.push(
        `quedaron ${missing.length} archivo(s) del diff sin bloque ni skipped: ${shown.join(", ")}${
          rest > 0 ? ` … y ${rest} más` : ""
        }`
      );
    }
  } else {
    notes.push("No contrasté cobertura contra git (sin lista de paths del diff).");
  }

  return { ok: errors.length === 0, errors, notes };
}

/**
 * @param {string} filePath
 * @param {{ repo?: string, branch?: string, base?: string, cwd?: string }} [opts]
 */
export function checkReportFile(filePath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  if (!existsSync(abs)) {
    return {
      ok: false,
      file: abs,
      errors: [`No existe el archivo: ${abs}`],
      notes: [],
      usage: true,
    };
  }

  let payload;
  try {
    payload = decodePayload(readFileSync(abs, "utf8"));
  } catch (err) {
    return {
      ok: false,
      file: abs,
      errors: [err instanceof Error ? err.message : String(err)],
      notes: [],
    };
  }

  const meta = payload && typeof payload === "object" ? payload.meta || {} : {};
  const branch = String(opts.branch || meta.branch || "").trim();
  const base = String(opts.base || meta.base || "develop").trim();
  const repoHint = String(opts.repo || meta.repo || "").trim();
  const repo =
    (repoHint && !/^(https?:\/\/|git@|ssh:\/\/)/i.test(repoHint) && tryResolveGitRoot(repoHint)) ||
    tryResolveGitRoot(cwd);

  /** @type {string[]} */
  let paths = [];
  /** @type {string[]} */
  const errors = [];

  if (!branch) {
    errors.push("Falta meta.branch (o --branch) para contrastar el diff.");
  } else if (!repo) {
    errors.push(
      "No encontré un repo git local (meta.repo o el directorio actual). Sin eso no puedo verificar cobertura."
    );
  } else {
    try {
      const extracted = extractBranchDiff({ repo, branch, base });
      paths = (extracted.files || []).map((f) => f.path);
    } catch (err) {
      errors.push(
        `No pude listar el diff con git (${err instanceof Error ? err.message : String(err)}). Revisá meta.repo, meta.branch y meta.base.`
      );
    }
  }

  const result = checkPayload(payload, paths);
  const allErrors = [...result.errors, ...errors];
  return { ok: allErrors.length === 0, errors: allErrors, notes: result.notes, file: abs };
}

/**
 * @param {string} file
 * @param {string} command
 * @param {{ ok: boolean, errors: string[], notes: string[] }} result
 */
export function formatCheckReport(file, command, result) {
  if (result.ok) {
    const extra = result.notes?.length ? `\n${result.notes.map((n) => `Note: ${n}`).join("\n")}` : "";
    return `OK: ${file}${extra}\nSchema and references passed. You can stop.`;
  }

  const problems = (result.errors || []).map((e) => `- ${e}`).join("\n");
  const notes = (result.notes || []).map((n) => `Note: ${n}`).join("\n");
  const lines = [
    `INVALID: ${file}`,
    "",
    "The JSON is not ready. Edit this same file until the command prints OK. Do not create a new filename.",
    "",
    "Problems:",
    problems || "- (unknown)",
  ];
  if (notes) lines.push("", notes);
  lines.push(
    "",
    "How to continue:",
    "- Fix every problem above in place. Keep existing meta/intent/groups/blocks/findings; only change what is wrong or missing.",
    '- Every diff path must appear in "blocks" or "skipped" (a skipped glob counts).',
    "- meta.agent and meta.model are required (product name and the exact model id you are running).",
    "- intent ≥40 chars; enums exactly as in the schema.",
    "- Human-readable strings in Spanish.",
    `- Re-run exactly: \`${command}\``,
    "- Stop only when that command prints OK."
  );
  return lines.join("\n");
}

/**
 * @param {string[]} argv args después de `validate`
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void, cwd?: string }} [io]
 * @returns {number} exit code
 */
export function runValidateCli(argv, io = {}) {
  const stdout = io.stdout || ((s) => console.log(s));
  const stderr = io.stderr || ((s) => console.error(s));
  const fileFlag = [];
  /** @type {{ repo?: string, branch?: string, base?: string }} */
  const opts = { cwd: io.cwd };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      stdout(`Usage: npx --yes @jpkme/diff-review validate <file.json> [--repo <path>] [--branch <b>] [--base <b>]

Exit 0 and "OK" when the JSON matches the review contract (and diff coverage, when git can list paths).
Exit 1 with problems and how to continue otherwise.`);
      return 0;
    }
    if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--branch") opts.branch = argv[++i];
    else if (a === "--base") opts.base = argv[++i];
    else if (a.startsWith("-")) {
      stderr(`Opción desconocida: ${a}`);
      return 2;
    } else fileFlag.push(a);
  }

  const file = fileFlag[0];
  if (!file) {
    stderr("Falta el archivo JSON. Uso: diff-review validate <file.json>");
    return 2;
  }

  const command = `npx --yes @jpkme/diff-review validate ${file}`;
  const result = checkReportFile(file, opts);
  const text = formatCheckReport(result.file || file, command, result);
  if (result.ok) stdout(text);
  else stderr(text);
  if (result.usage) return 2;
  return result.ok ? 0 : 1;
}
