/**
 * Nombre del JSON que escribe el agente.
 * Preferido: tips cortos branch/base. Legacy (con stamp o sin tips) sigue válido al importar.
 */
import { fingerprint } from "./fingerprint.mjs";

/** Prefijo del formato actual. */
export const OUTPUT_PREFIX = "diff-rev";

/** Prefijo legacy (sin tips / con stamp). */
export const OUTPUT_PREFIX_LEGACY = "diff-review-output";
export const OUTPUT_PREFIX_REPORT = "diff-report";

/** Nombre legacy fijo. */
export const OUTPUT_FILENAME_LEGACY = `${OUTPUT_PREFIX_LEGACY}.json`;

/**
 * Válidos:
 * - diff-rev_{branchTip}_{baseTip}.json
 * - diff-report_{branchTip}-{baseTip}_YYYYMMDD-HHmmss.json (legacy)
 * - diff-review-output.json / diff-review-output-YYYYMMDD-HHmmss.json (legacy)
 */
export const OUTPUT_FILENAME_RE =
  /^(?:diff-rev_[0-9a-f]{7,12}_[0-9a-f]{7,12}|diff-report_[0-9a-f]{7,12}-[0-9a-f]{7,12}_\d{8}-\d{6}|diff-review-output(?:-\d{8}-\d{6})?)\.json$/i;

/**
 * @param {{ branchSha?: string, baseSha?: string }} [input]
 * @returns {string}
 *   con tips: diff-rev_aaaaaaaaaa_bbbbbbbbbb.json
 *   sin tips: diff-review-output.json
 */
export function makeOutputFilename(input = {}) {
  const opts = input instanceof Date ? {} : input || {};
  const fp = fingerprint(opts.branchSha, opts.baseSha);
  if (fp) {
    const [branchTip, baseTip] = fp.split("-");
    if (branchTip && baseTip) return `${OUTPUT_PREFIX}_${branchTip}_${baseTip}.json`;
  }
  return OUTPUT_FILENAME_LEGACY;
}

export function isOutputFilename(name) {
  return OUTPUT_FILENAME_RE.test(String(name || "").trim());
}
