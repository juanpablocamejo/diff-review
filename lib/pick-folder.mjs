import { execFileSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Abre el diálogo nativo del OS para elegir una carpeta.
 * @returns {string|null} Ruta absoluta, o null si el usuario canceló.
 */
export function pickFolder() {
  const os = platform();
  if (os === "win32") return pickWindows();
  if (os === "darwin") return pickMac();
  return pickLinux();
}

function pickWindows() {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = 'Elegí el repositorio git'",
    "$d.ShowNewFolderButton = $false",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
  ].join("; ");
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: false, timeout: 10 * 60 * 1000 },
    );
    const path = String(out || "").trim();
    return path || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/canceled|cancelled|abort/i.test(msg)) return null;
    throw new Error("No se pudo abrir el diálogo de carpetas: " + msg);
  }
}

function pickMac() {
  try {
    const out = execFileSync(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Elegí el repositorio git")'],
      { encoding: "utf8", timeout: 10 * 60 * 1000 },
    );
    return String(out || "")
      .trim()
      .replace(/\/$/, "");
  } catch (err) {
    const status = /** @type {{ status?: number }} */ (err).status;
    // -128 = user canceled
    if (status === 1 || /User canceled|-128/i.test(String(err))) return null;
    throw new Error(
      "No se pudo abrir el diálogo de carpetas: " + (err instanceof Error ? err.message : String(err)),
    );
  }
}

function pickLinux() {
  try {
    const out = execFileSync(
      "zenity",
      ["--file-selection", "--directory", "--title=Elegí el repositorio git"],
      { encoding: "utf8", timeout: 10 * 60 * 1000 },
    );
    return String(out || "").trim() || null;
  } catch (zenityErr) {
    const zStatus = /** @type {{ status?: number }} */ (zenityErr).status;
    if (zStatus === 1) return null; // cancel
    try {
      const out = execFileSync(
        "kdialog",
        ["--getexistingdirectory", ".", "Elegí el repositorio git"],
        { encoding: "utf8", timeout: 10 * 60 * 1000 },
      );
      return String(out || "").trim() || null;
    } catch (kErr) {
      const kStatus = /** @type {{ status?: number }} */ (kErr).status;
      if (kStatus === 1) return null;
      throw new Error(
        "No hay diálogo de carpetas disponible. Instalá zenity o kdialog, o pegá la ruta a mano.",
      );
    }
  }
}
