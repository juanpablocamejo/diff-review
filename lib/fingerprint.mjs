/**
 * Tips cortos de SHA. Sin APIs de Node: la UI lo importa para armar el nombre del JSON.
 */

export function shortSha(sha, n = 10) {
  const hex = String(sha || "")
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "");
  return hex.length >= 7 ? hex.slice(0, n) : "";
}

export function fingerprint(branchSha, baseSha) {
  const a = shortSha(branchSha);
  const b = shortSha(baseSha);
  if (!a || !b) return null;
  return `${a}-${b}`;
}

/** File/URL id: short tip of the reviewed branch + short tip of the base. */
export function reportId(branchSha, baseSha) {
  const id = fingerprint(branchSha, baseSha);
  if (!id) throw new Error("Faltan SHAs de los tips para el id del reporte.");
  return id;
}
