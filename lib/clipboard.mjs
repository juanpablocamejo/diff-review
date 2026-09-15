import { spawnSync } from "node:child_process";

/** Copia texto al portapapeles del SO. Devuelve true si parece haber funcionado. */
export function copyTextToClipboard(text) {
  const value = String(text ?? "");
  try {
    if (process.platform === "win32") {
      const r = spawnSync("clip", [], {
        input: value,
        encoding: "utf8",
        windowsHide: true,
      });
      return r.status === 0;
    }
    if (process.platform === "darwin") {
      const r = spawnSync("pbcopy", [], { input: value, encoding: "utf8" });
      return r.status === 0;
    }
    let r = spawnSync("wl-copy", [], { input: value, encoding: "utf8" });
    if (r.status === 0) return true;
    r = spawnSync("xclip", ["-selection", "clipboard"], {
      input: value,
      encoding: "utf8",
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
