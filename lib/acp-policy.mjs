/**
 * Qué puede hacer el agente cuando corre por ACP. Cada `session/request_permission` pasa por acá: no hay nadie
 * mirando la terminal para aprobar, así que la política es una allowlist (leer, comandos de solo lectura y escribir
 * el JSON de la review) y todo lo demás se rechaza.
 *
 * Ojo: el agente solo pide permiso para lo que *su* configuración no aprueba sola (p. ej. Claude Code aplica la
 * allowlist de `~/.claude/settings.json` antes de preguntar). Esto acota lo que pide, no lo que el usuario ya
 * habilitó en su agente.
 */
import { isAbsolute, normalize, resolve } from "node:path";
import { checkShell } from "./acp-shell.mjs";

/**
 * @typedef {"review" | "ask" | "edit"} PolicyMode
 *   review = generar el JSON; ask = preguntas (no puede escribir nada); edit = modificar el JSON.
 * @typedef {{ repo: string, outputFilename: string, mode: PolicyMode }} PolicyContext
 * @typedef {{
 *   kind?: string | null,
 *   title?: string | null,
 *   rawInput?: unknown,
 *   locations?: { path: string }[] | null,
 *   content?: { type: string, path?: string }[] | null,
 * }} ToolCallLike
 * @typedef {{ allow: boolean, reason: string }} Decision
 */

/** @param {string} a @param {string} b */
function samePath(a, b, platform = process.platform) {
  const na = normalize(a);
  const nb = normalize(b);
  return platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** @param {string} child @param {string} root */
function isInside(child, root, platform = process.platform) {
  const c = normalize(child);
  const r = normalize(root).replace(/[\\/]+$/, "");
  const [cc, rr] = platform === "win32" ? [c.toLowerCase(), r.toLowerCase()] : [c, r];
  return cc === rr || cc.startsWith(`${rr}\\`) || cc.startsWith(`${rr}/`);
}

/** Paths que toca la tool call (`locations`, diffs de `content` y los campos típicos de `rawInput`). */
export function toolCallPaths(toolCall, repo) {
  const raw = toolCall.rawInput && typeof toolCall.rawInput === "object" ? /** @type {Record<string, unknown>} */ (toolCall.rawInput) : {};
  const candidates = [
    ...(toolCall.locations ?? []).map((l) => l?.path),
    ...(toolCall.content ?? []).map((c) => (c?.type === "diff" ? c.path : undefined)),
    raw.file_path,
    raw.path,
    raw.filePath,
    raw.notebook_path,
  ];
  const out = [];
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    const abs = isAbsolute(c) ? c : resolve(repo, c);
    if (!out.some((p) => samePath(p, abs))) out.push(abs);
  }
  return out;
}

/** @param {unknown} rawInput */
function commandOf(rawInput) {
  if (!rawInput || typeof rawInput !== "object") return "";
  const cmd = /** @type {Record<string, unknown>} */ (rawInput).command;
  if (Array.isArray(cmd)) return cmd.map(String).join(" ");
  return typeof cmd === "string" ? cmd : "";
}

/**
 * ¿El comando de shell solo lee? Ver `checkShell` en `acp-shell.mjs`.
 * @param {string} command
 * @param {{ repo?: string }} [opts]
 */
export function isAllowedShell(command, opts) {
  return checkShell(command, opts).ok;
}

/**
 * @param {ToolCallLike} toolCall
 * @param {PolicyContext} ctx
 * @returns {Decision}
 */
export function decidePermission(toolCall, { repo, outputFilename, mode }) {
  const kind = toolCall.kind ?? "other";
  const paths = toolCallPaths(toolCall, repo);

  if (kind === "read" || kind === "search") {
    const outside = paths.find((p) => !isInside(p, repo));
    return outside ? { allow: false, reason: `lectura fuera del repo: ${outside}` } : { allow: true, reason: "lectura" };
  }
  if (kind === "think") return { allow: true, reason: "pensar" };

  if (kind === "execute") {
    // Cursor no manda `rawInput`: el comando viene solo en el título, entre backticks.
    const title = String(toolCall.title ?? "").trim();
    const cmd = commandOf(toolCall.rawInput) || (/^`([\s\S]+)`$/.exec(title)?.[1] ?? title);
    const check = checkShell(cmd, { repo });
    return check.ok ? { allow: true, reason: "comando de solo lectura" } : { allow: false, reason: check.reason };
  }

  if (kind === "edit") {
    if (mode === "ask") return { allow: false, reason: "modo pregunta: no se edita nada" };
    const target = resolve(repo, outputFilename);
    if (!paths.length) return { allow: false, reason: "edición sin path" };
    const other = paths.find((p) => !samePath(p, target));
    return other ? { allow: false, reason: `solo se puede escribir ${outputFilename} (no ${other})` } : { allow: true, reason: "JSON de la review" };
  }

  return { allow: false, reason: `${kind} no permitido: ${toolCall.title ?? "?"}` };
}

/**
 * Respuesta ACP para una decisión: elige la opción "una vez" (nunca "siempre", así la política se evalúa cada vez).
 * @param {{ optionId: string, kind: string }[]} options
 * @param {boolean} allow
 */
export function permissionOutcome(options, allow) {
  const kinds = allow ? ["allow_once"] : ["reject_once", "reject_always"];
  const option = kinds.map((kind) => options.find((o) => o.kind === kind)).find(Boolean);
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}
