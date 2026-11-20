/**
 * Nombre del JSON que escribe el agente.
 * Preferido: tips cortos branch/base. Legacy (con stamp o sin tips) sigue válido al importar.
 */
import { fingerprint, shortSha } from "./fingerprint.mjs";

/** Prefijo del formato actual. */
export const OUTPUT_PREFIX = "diff-rev";

/** Prefijo legacy (sin tips / con stamp). */
export const OUTPUT_PREFIX_LEGACY = "diff-review-output";
export const OUTPUT_PREFIX_REPORT = "diff-report";

/** Carpeta (en la raíz del repo revisado) donde va el JSON, el diff y la sesión del agente. */
export const OUTPUT_DIR = ".diff-review";

/** Path relativo a la raíz del repo, con `/` (el que se le da al agente): `.diff-review/<nombre>`. */
export function outputRelPath(filename) {
  return `${OUTPUT_DIR}/${String(filename || "").replace(/^.*[\\/]/, "")}`;
}

/** Companion de handoff: mismo stem que el JSON → `.diff-review/<stem>.chat.md`. */
export function chatRelPath(filename) {
  const name = String(filename || "").replace(/^.*[\\/]/, "");
  const stem = name.replace(/\.json$/i, "") || "diff-rev";
  return `${OUTPUT_DIR}/${stem}.chat.md`;
}

/** Nombre legacy fijo. */
export const OUTPUT_FILENAME_LEGACY = `${OUTPUT_PREFIX_LEGACY}.json`;

/**
 * Válidos:
 * - diff-rev_{branchTip}_{baseTip}.json (reviews viejas, solo tips)
 * - diff-rev_{branchTip}_{baseTip}_{diffHash}.json (el hash del diff evita colisión limpio/dirty)
 * - diff-report_{branchTip}-{baseTip}_YYYYMMDD-HHmmss.json (legacy)
 * - diff-review-output.json / diff-review-output-YYYYMMDD-HHmmss.json (legacy)
 */
export const OUTPUT_FILENAME_RE =
  /^(?:diff-rev_[0-9a-f]{7,12}_[0-9a-f]{7,12}(?:_[0-9a-f]{7,12})?|diff-report_[0-9a-f]{7,12}-[0-9a-f]{7,12}_\d{8}-\d{6}|diff-review-output(?:-\d{8}-\d{6})?)\.json$/i;

/**
 * @param {{ branchSha?: string, baseSha?: string, diffHash?: string }} [input]
 * @returns {string}
 *   con tips y hash del diff: diff-rev_aaaaaaaaaa_bbbbbbbbbb_cccccccccc.json
 *   con tips, sin hash: diff-rev_aaaaaaaaaa_bbbbbbbbbb.json
 *   sin tips: diff-review-output.json
 *
 * El hash es del contenido del diff (no un token "dirty"). Un árbol limpio y uno sucio
 * con los mismos tips no comparten nombre. No se agrega un token dirty: el hash ya cambia.
 */
export function makeOutputFilename(input = {}) {
  const opts = input instanceof Date ? {} : input || {};
  const fp = fingerprint(opts.branchSha, opts.baseSha);
  const diffHash = shortSha(opts.diffHash, 10);
  if (fp) {
    const [branchTip, baseTip] = fp.split("-");
    if (branchTip && baseTip) {
      if (diffHash) return `${OUTPUT_PREFIX}_${branchTip}_${baseTip}_${diffHash}.json`;
      return `${OUTPUT_PREFIX}_${branchTip}_${baseTip}.json`;
    }
  }
  return OUTPUT_FILENAME_LEGACY;
}

/**
 * Nombre con marca de tiempo, distinto del canónico `diff-rev_…`.
 * Sirve para una review nueva que no debe pisar el JSON que ya está abierto.
 * El formato es el legacy que `isOutputFilename` acepta.
 * @param {{ branchSha?: string, baseSha?: string, now?: Date }} [input]
 */
export function makeStampedOutputFilename(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const fp = fingerprint(input.branchSha, input.baseSha);
  if (fp) {
    const [branchTip, baseTip] = fp.split("-");
    if (branchTip && baseTip) return `diff-report_${branchTip}-${baseTip}_${stamp}.json`;
  }
  return `diff-review-output-${stamp}.json`;
}

export function isOutputFilename(name) {
  return OUTPUT_FILENAME_RE.test(String(name || "").trim());
}
