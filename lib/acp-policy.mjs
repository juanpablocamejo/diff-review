/**
 * Qué puede hacer el agente cuando corre por ACP. Cada `session/request_permission` pasa por acá: no hay nadie
 * mirando la terminal para aprobar, así que la política es una allowlist (leer, comandos de solo lectura y escribir
 * el JSON de salida en `.diff-review/`) y todo lo demás se rechaza.
 *
 * Ojo: el agente solo pide permiso para lo que *su* configuración no aprueba sola (p. ej. Claude Code aplica la
 * allowlist de `~/.claude/settings.json` antes de preguntar). Esto acota lo que pide, no lo que el usuario ya
 * habilitó en su agente.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { checkShell } from "./acp-shell.mjs";
import { outputRelPath } from "./output-name.mjs";

/**
 * @typedef {"review" | "ask" | "edit" | "fix"} PolicyMode
 *   review = generar el JSON; ask = preguntas (no puede escribir nada); edit = modificar el JSON;
 *   fix = editar código dentro del repo (no solo el JSON).
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

/**
 * Resuelve symlinks cuando el path (o un ancestro) existe. Sin eso, un link dentro del repo
 * puede apuntar fuera y pasar `isInside` con solo `resolve`.
 * @param {string} path
 */
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    const parts = [];
    let cur = normalize(path);
    for (;;) {
      const parent = dirname(cur);
      if (!parent || parent === cur) return normalize(path);
      parts.unshift(basename(cur));
      try {
        return resolve(realpathSync(parent), ...parts);
      } catch {
        cur = parent;
      }
    }
  }
}

/** @param {string} child @param {string} root */
function isInside(child, root, platform = process.platform) {
  const c = normalize(canonicalPath(child));
  const r = normalize(canonicalPath(root)).replace(/[\\/]+$/, "");
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
 * Comando de shell que la política evalúa (rawInput, backticks o título entero).
 * Cursor a veces envuelve el script con `@…@` en el título.
 * @param {ToolCallLike} toolCall
 */
export function toolCallCommand(toolCall) {
  const fromRaw = commandOf(toolCall.rawInput).trim();
  if (fromRaw) return fromRaw;
  const title = String(toolCall.title ?? "").trim();
  const tick = /^`([\s\S]+)`$/.exec(title);
  if (tick) return tick[1].trim();
  const at = /^@\s*([\s\S]*?)\s*@$/.exec(title);
  if (at) return at[1].trim();
  return title;
}

/**
 * Etiqueta corta del agente si el título no es el comando mismo.
 * @param {ToolCallLike} toolCall
 * @param {string} [command]
 */
export function toolCallLabel(toolCall, command = toolCallCommand(toolCall)) {
  const title = String(toolCall.title ?? "").trim();
  if (!title) return "";
  if (/^`[\s\S]+`$/.test(title) || /^@\s*[\s\S]*?\s*@$/.test(title)) return "";
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  if (command && norm(title) === norm(command)) return "";
  if (command && command.length >= 24 && title.includes(command.slice(0, 24))) return "";
  return title;
}

/**
 * Motivo de denegación legible en la UI de permisos.
 * @param {string} reason
 */
export function humanizePolicyReason(reason) {
  const r = String(reason || "").trim();
  if (!r) return "La política bloqueó este pedido.";
  let m;
  if ((m = /^(.+?) no está permitido$/.exec(r))) {
    return `La política bloqueó «${m[1]}» (no está en la allowlist de comandos).`;
  }
  if ((m = /^variables de entorno en el comando:\s*(.*)$/s.exec(r))) {
    const token = String(m[1] || "?").trim().slice(0, 40);
    return `La política interpretó parte del comando como variable de entorno (${token}) y lo bloqueó.`;
  }
  if ((m = /^path fuera del repo:\s*(.*)$/s.exec(r))) {
    return `El path queda fuera del repo: ${m[1]}`;
  }
  if ((m = /^lectura fuera del repo:\s*(.*)$/s.exec(r))) {
    return `Lectura fuera del repo: ${m[1]}`;
  }
  if ((m = /^opción global de git no permitida:\s*(.*)$/s.exec(r))) {
    return `Opción de git no permitida: ${m[1]}`;
  }
  if (r.startsWith("git ")) return `Comando git no permitido por la política: ${r}`;
  if (r.startsWith("solo se puede escribir") || r.includes("sin path") || r.startsWith("modo pregunta")) return r;
  return `La política bloqueó el pedido: ${r}`;
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
    if (!paths.length) {
      return { allow: false, reason: `${kind === "search" ? "búsqueda" : "lectura"} sin path` };
    }
    const outside = paths.find((p) => !isInside(p, repo));
    return outside ? { allow: false, reason: `lectura fuera del repo: ${outside}` } : { allow: true, reason: "lectura" };
  }
  if (kind === "think") return { allow: true, reason: "pensar" };

  if (kind === "execute") {
    // Cursor no manda `rawInput`: el comando viene en el título (backticks / @…@ / texto).
    const cmd = toolCallCommand(toolCall);
    const check = checkShell(cmd, { repo });
    return check.ok ? { allow: true, reason: "comando de solo lectura" } : { allow: false, reason: check.reason };
  }

  if (kind === "edit" || kind === "delete") {
    if (mode === "ask") return { allow: false, reason: "modo pregunta: no se edita nada" };
    if (!paths.length) return { allow: false, reason: `${kind === "delete" ? "borrado" : "edición"} sin path` };
    if (mode === "fix") {
      const outside = paths.find((p) => !isInside(p, repo));
      return outside
        ? { allow: false, reason: `path fuera del repo: ${outside}` }
        : { allow: true, reason: "escritura en el repo" };
    }
    const target = resolve(repo, outputRelPath(outputFilename));
    const outside = paths.find((p) => !samePath(canonicalPath(p), canonicalPath(target)));
    return outside
      ? {
          allow: false,
          reason: `solo se puede escribir ${outputRelPath(outputFilename)} (no ${outside})`
        }
      : { allow: true, reason: `escritura de ${outputRelPath(outputFilename)}` };
  }

  return { allow: false, reason: `${kind} no permitido: ${toolCall.title ?? "?"}` };
}

/**
 * Respuesta ACP para una decisión del usuario / política.
 * - allow + once → `allow_once` (la política se vuelve a evaluar en el próximo pedido).
 * - allow + always → `allow_always` si el agente la ofrece; si no, cae a `allow_once`.
 * @param {{ optionId: string, kind: string }[]} options
 * @param {boolean} allow
 * @param {{ always?: boolean }} [opts]
 */
export function permissionOutcome(options, allow, opts = {}) {
  const always = Boolean(opts.always);
  const kinds = allow
    ? always
      ? ["allow_always", "allow_once"]
      : ["allow_once"]
    : ["reject_once", "reject_always"];
  const option = kinds.map((kind) => options.find((o) => o.kind === kind)).find(Boolean);
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}
