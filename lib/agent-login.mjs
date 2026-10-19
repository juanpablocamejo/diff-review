/**
 * Login de agentes ACP: mensajes claros + abrir una terminal interactiva cuando se pueda.
 */
import { spawn } from "node:child_process";

/**
 * @typedef {{ bin: string, args: string[], display: string }} LoginCommand
 */

/**
 * Comando de login interactivo por agente (null = no hay CLI de login, p. ej. Cursor app).
 * @param {string} agentId
 * @returns {LoginCommand | null}
 */
export function loginCommand(agentId) {
  switch (agentId) {
    case "claude":
      return { bin: "claude", args: ["/login"], display: "claude /login" };
    case "copilot":
      return { bin: "gh", args: ["auth", "login"], display: "gh auth login" };
    case "codex":
      return { bin: "codex", args: ["login"], display: "codex login" };
    case "gemini":
      return { bin: "gemini", args: [], display: "gemini" }; // el CLI guía el auth al arrancar
    default:
      return null;
  }
}

/** @param {string} text */
export function looksLikeAuthFailure(text) {
  const s = String(text || "").toLowerCase();
  return /(not\s+)?auth|login|unauthor|not logged|sign[\s-]?in|credentials|token.*(invalid|expired|missing)|please\s+run/.test(
    s
  );
}

/**
 * Mensaje en español si el agente murió / falló por falta de login.
 * @param {string} agentId
 * @param {string} agentLabel
 * @param {string} detail
 * @returns {string | null}
 */
export function authFailureMessage(agentId, agentLabel, detail) {
  if (!looksLikeAuthFailure(detail)) return null;
  const cmd = loginCommand(agentId);
  if (agentId === "cursor") {
    return `${agentLabel} no está autenticado. Iniciá sesión en la app de Cursor y reintentá.`;
  }
  if (cmd) {
    return `${agentLabel} no está autenticado. Corré \`${cmd.display}\` en una terminal y reintentá.`;
  }
  return `${agentLabel} no está autenticado. Revisá el login del agente y reintentá.`;
}

/**
 * Abre una terminal nueva con el login del agente (Windows / macOS / Linux).
 * @param {string} agentId
 * @returns {{ display: string }}
 */
export function openLoginTerminal(agentId) {
  const cmd = loginCommand(agentId);
  if (!cmd) {
    throw new Error(
      agentId === "cursor"
        ? "Cursor se autentica desde la app de escritorio, no desde una terminal."
        : "Este agente no tiene un comando de login conocido."
    );
  }

  const platform = process.platform;
  if (platform === "win32") {
    // `start "title" cmd /k …` — el primer quoted es el título de la ventana.
    spawn("cmd.exe", ["/c", "start", `${cmd.bin} login`, "cmd.exe", "/k", cmd.bin, ...cmd.args], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref();
  } else if (platform === "darwin") {
    const script = `tell application "Terminal" to do script ${JSON.stringify(`${cmd.bin} ${cmd.args.join(" ")}`.trim())}`;
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
  } else {
    const line = `${cmd.bin} ${cmd.args.join(" ")}`.trim();
    const tried = [
      ["x-terminal-emulator", ["-e", "bash", "-lc", `${line}; exec bash`]],
      ["gnome-terminal", ["--", "bash", "-lc", `${line}; exec bash`]],
      ["konsole", ["-e", "bash", "-lc", `${line}; exec bash`]],
      ["xterm", ["-e", "bash", "-lc", `${line}; exec bash`]],
    ];
    let ok = false;
    for (const [bin, args] of tried) {
      try {
        spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
        ok = true;
        break;
      } catch {
        /* siguiente */
      }
    }
    if (!ok) throw new Error(`No pude abrir una terminal. Corré a mano: ${cmd.display}`);
  }

  return { display: cmd.display };
}
