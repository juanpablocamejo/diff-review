/**
 * Nombre del JSON que escribe el agente.
 * Preferido: tips cortos + stamp. Legacy sin tips sigue siendo válido al importar.
 */
import { fingerprint } from "./git.mjs";

/** Prefijo del formato actual (con tips). */
export const OUTPUT_PREFIX = "diff-report";

/** Prefijo legacy (sin tips). */
export const OUTPUT_PREFIX_LEGACY = "diff-review-output";

/** Nombre legacy fijo. */
export const OUTPUT_FILENAME_LEGACY = `${OUTPUT_PREFIX_LEGACY}.json`;

/**
 * Válidos:
 * - diff-review-output.json
 * - diff-review-output-YYYYMMDD-HHmmss.json
 * - diff-report_{branchTip}-{baseTip}_YYYYMMDD-HHmmss.json
 */
export const OUTPUT_FILENAME_RE =
  /^(?:diff-review-output(?:-\d{8}-\d{6})?|diff-report_[0-9a-f]{7,12}-[0-9a-f]{7,12}_\d{8}-\d{6})\.json$/i;

/**
 * @param {Date} [when]
 * @returns {string} ej. 20260915-143045
 */
export function formatOutputStamp(when = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = when.getFullYear();
  const mo = pad(when.getMonth() + 1);
  const d = pad(when.getDate());
  const h = pad(when.getHours());
  const mi = pad(when.getMinutes());
  const s = pad(when.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * @param {{ branchSha?: string, baseSha?: string, stamp?: string, when?: Date } | Date} [input]
 * @returns {string}
 *   con tips: diff-report_aaaaaaaaaa-bbbbbbbbbb_20260915-143045.json
 *   sin tips: diff-review-output-20260915-143045.json
 */
export function makeOutputFilename(input = {}) {
  const opts = input instanceof Date ? { when: input } : input || {};
  const stamp = opts.stamp || formatOutputStamp(opts.when ?? new Date());
  const fp = fingerprint(opts.branchSha, opts.baseSha);
  if (fp) return `${OUTPUT_PREFIX}_${fp}_${stamp}.json`;
  return `${OUTPUT_PREFIX_LEGACY}-${stamp}.json`;
}

export function isOutputFilename(name) {
  return OUTPUT_FILENAME_RE.test(String(name || "").trim());
}
