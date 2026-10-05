/**
 * Agentes de código que la CLI puede lanzar con el prompt (`--agent`).
 *
 * No hay un registro de agentes en ningún SO: se detectan por nombre en el PATH más algunas rutas fijas
 * conocidas (p. ej. el Claude Code que trae la app de escritorio en Windows). El prompt viaja por stdin, así
 * no se toca el portapapeles ni se choca con el límite de largo de la línea de comandos de los shims `.cmd`.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * @typedef {{ value: string, label: string, hint?: string }} ModelOption
 * @typedef {{ model?: string, outputFilename: string }} RunSpec
 * @typedef {{
 *   id: string,
 *   label: string,
 *   bins: string[],
 *   extraPaths?: (ctx: DetectContext) => string[],
 *   models: ModelOption[],
 *   configuredModel?: (ctx: DetectContext) => { model: string, source: string } | null,
 *   args: (spec: RunSpec) => string[],
 * }} AgentDef
 * @typedef {{ env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string }} DetectContext
 * @typedef {{ def: AgentDef, path: string }} DetectedAgent
 */

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Primer `model = "..."` de nivel raíz de un TOML (antes de cualquier `[sección]`). */
export function topLevelTomlModel(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*model\s*=\s*["']([^"']+)["']/);
    if (m) return m[1];
  }
  return null;
}

/** Versiones tipo `2.1.286` de mayor a menor (las que no parsean, al final). */
function byVersionDesc(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return Number.isNaN(d) ? 0 : d;
  }
  return 0;
}

/** `<root>/<versión>/<hash>/<exe>` → rutas, de la versión más nueva a la más vieja. */
function versionedBinaries(root, exe) {
  /** @type {string[]} */
  const out = [];
  let versions;
  try {
    versions = readdirSync(root).sort(byVersionDesc);
  } catch {
    return out;
  }
  for (const version of versions) {
    let entries;
    try {
      entries = readdirSync(join(root, version));
    } catch {
      continue;
    }
    for (const entry of entries) out.push(join(root, version, entry, exe));
  }
  return out;
}

/** @type {AgentDef[]} */
export const AGENTS = [
  {
    id: "claude",
    label: "Claude Code",
    bins: ["claude"],
    extraPaths: ({ env, platform, home }) => {
      if (platform === "win32") {
        // La app de escritorio trae su propio Claude Code, fuera del PATH.
        const appData = env.APPDATA || join(home, "AppData", "Roaming");
        return versionedBinaries(join(appData, "Claude", "claude-code"), "claude.exe");
      }
      const paths = [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
      if (platform === "darwin") {
        paths.push(...versionedBinaries(join(home, "Library", "Application Support", "Claude", "claude-code"), "claude"));
      }
      return paths;
    },
    // Alias estables del CLI: siempre apuntan al último modelo de cada familia.
    models: [
      { value: "opus", label: "opus", hint: "el más capaz" },
      { value: "sonnet", label: "sonnet", hint: "equilibrado" },
      { value: "haiku", label: "haiku", hint: "el más rápido" },
    ],
    configuredModel: ({ env, home }) => {
      if (env.ANTHROPIC_MODEL) return { model: env.ANTHROPIC_MODEL, source: "ANTHROPIC_MODEL" };
      const file = join(home, ".claude", "settings.json");
      const model = readJson(file)?.model;
      return typeof model === "string" && model ? { model, source: "~/.claude/settings.json" } : null;
    },
    args: ({ model, outputFilename }) => [
      "-p",
      ...(model ? ["--model", model] : []),
      // Solo lectura + git + el validate, y escribir únicamente el JSON del review (Edit cubre Write).
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "Bash(git:*)",
      "Bash(npx --yes @jpkme/diff-review validate:*)",
      `Edit(./${outputFilename})`,
    ],
  },
  {
    id: "codex",
    label: "Codex",
    bins: ["codex"],
    models: [],
    configuredModel: ({ home }) => {
      try {
        const model = topLevelTomlModel(readFileSync(join(home, ".codex", "config.toml"), "utf8"));
        return model ? { model, source: "~/.codex/config.toml" } : null;
      } catch {
        return null;
      }
    },
    // `-` = prompt por stdin; workspace-write deja escribir el JSON en el repo.
    args: ({ model }) => ["exec", "--sandbox", "workspace-write", ...(model ? ["-m", model] : []), "-"],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bins: ["gemini"],
    models: [],
    configuredModel: ({ home }) => {
      const model = readJson(join(home, ".gemini", "settings.json"))?.model;
      const name = typeof model === "string" ? model : model?.name;
      return typeof name === "string" && name ? { model: name, source: "~/.gemini/settings.json" } : null;
    },
    // Sin TTY lee el prompt de stdin; yolo porque no hay quién apruebe los comandos.
    args: ({ model }) => [...(model ? ["-m", model] : []), "--yolo"],
  },
];

/** @param {string} file @param {NodeJS.Platform} platform */
function isExecutable(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Busca `name` en el PATH (con las extensiones de PATHEXT en Windows). */
export function findOnPath(name, { env, platform }) {
  const dirs = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const exts =
    platform === "win32"
      ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** @param {Partial<DetectContext>} [ctx] */
function context(ctx = {}) {
  return { env: ctx.env ?? process.env, platform: ctx.platform ?? process.platform, home: ctx.home ?? homedir() };
}

/**
 * Agentes instalados, en el orden de `AGENTS`. Primero el PATH, después las rutas fijas.
 * @param {Partial<DetectContext>} [ctx]
 * @returns {DetectedAgent[]}
 */
export function detectAgents(ctx) {
  const c = context(ctx);
  /** @type {DetectedAgent[]} */
  const found = [];
  for (const def of AGENTS) {
    let path = null;
    for (const bin of def.bins) {
      path = findOnPath(bin, c);
      if (path) break;
    }
    if (!path) path = (def.extraPaths?.(c) ?? []).find((p) => existsSync(p) && isExecutable(p, c.platform)) ?? null;
    if (path) found.push({ def, path });
  }
  return found;
}

/** Valor del select para "no pasar --model" (que el agente use el suyo). */
export const AGENT_DEFAULT_MODEL = "";
/** Valor del select para escribir un id de modelo a mano. */
export const OTHER_MODEL = "__other__";

/**
 * Opciones del select de modelo: primero el default del agente (marcado como inicial), después los conocidos y
 * "Otro…". Si el default configurado coincide con uno conocido, no se repite.
 * @param {AgentDef} def
 * @param {Partial<DetectContext>} [ctx]
 * @returns {{ options: ModelOption[], initialValue: string }}
 */
export function modelChoices(def, ctx) {
  const configured = def.configuredModel?.(context(ctx)) ?? null;
  const first = configured
    ? { value: AGENT_DEFAULT_MODEL, label: `Por defecto (${configured.model})`, hint: configured.source }
    : { value: AGENT_DEFAULT_MODEL, label: "Por defecto del agente", hint: "no se pasa --model" };
  const rest = def.models.filter((m) => m.value !== configured?.model);
  return {
    options: [first, ...rest, { value: OTHER_MODEL, label: "Otro…", hint: "escribir el id del modelo" }],
    initialValue: AGENT_DEFAULT_MODEL,
  };
}

/** Comillas para cmd.exe (solo hace falta con los shims .cmd/.bat de npm). */
function quoteForCmd(arg) {
  return /^[\w./:@=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Lanza el agente en el repo con el prompt por stdin; stdout/stderr van a la terminal.
 * @param {DetectedAgent} agent
 * @param {{ cwd: string, prompt: string } & RunSpec} spec
 * @returns {{ child: import('node:child_process').ChildProcess, exited: Promise<number> }}
 */
export function runAgent(agent, { cwd, prompt, model, outputFilename }) {
  const args = agent.def.args({ model, outputFilename });
  // Node no lanza .cmd/.bat sin shell (CVE-2024-27980); con shell hay que citar a mano.
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(agent.path);
  const child = viaShell
    ? spawn([agent.path, ...args].map(quoteForCmd).join(" "), { cwd, shell: true, stdio: ["pipe", "inherit", "inherit"] })
    : spawn(agent.path, args, { cwd, stdio: ["pipe", "inherit", "inherit"] });
  child.stdin?.end(prompt);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  return { child, exited };
}
