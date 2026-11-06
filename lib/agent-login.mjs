/**
 * Login de agentes ACP: clasificación de authMethods, mensajes claros y lanzamiento del CLI de auth.
 *
 * Preferencia de launch:
 * 1. Misma TTY (stdio inherit) si stdin/stdout son TTY — CLI interactiva, exit code real.
 * 2. Proceso hijo oculto (sin ventana de terminal) si no hay TTY — p. ej. web; OAuth abre el browser.
 * 3. Terminal externa solo con `external: true` (raro: login que exige TTY interactiva).
 *
 * En Windows, `cmd /c start /wait` **no** propaga el exit code del proceso iniciado (siempre 0
 * hacia Node). El fallback externo usa un archivo sentinel, igual que macOS/Linux.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCommand } from "./agents.mjs";

/**
 * @typedef {{ bin: string, args: string[], display: string, env?: Record<string, string> }} LoginCommand
 * @typedef {'agent' | 'terminal' | 'terminal-meta' | 'unknown'} AuthMethodKind
 * @typedef {'inherit' | 'hidden' | 'external'} LoginLaunchMode
 */

/**
 * Hostname de Copilot (Enterprise). Vacío / `github.com` = cuenta en github.com.
 * @param {string | null | undefined} host
 * @returns {string}
 */
export function normalizeCopilotLoginHost(host) {
  const h = String(host || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  if (!h || /^github\.com$/i.test(h)) return "";
  return h;
}

/**
 * Agrega `--host` a un comando `copilot login` cuando el usuario eligió Enterprise.
 * No fuerza nada por env: el host lo elige quien llama (CLI/UI).
 * @param {LoginCommand} cmd
 * @param {string | null | undefined} host
 * @returns {LoginCommand}
 */
export function withCopilotLoginHost(cmd, host) {
  if (!cmd || cmd.bin == null) return cmd;
  const h = normalizeCopilotLoginHost(host);
  if (!h) return cmd;
  const args = Array.isArray(cmd.args) ? [...cmd.args] : [];
  const hostIdx = args.findIndex((a) => a === "--host");
  if (hostIdx >= 0) {
    args[hostIdx + 1] = h;
  } else {
    args.push("--host", h);
  }
  const withoutHost = String(cmd.display || "")
    .replace(/\s+--host\s+\S+/g, "")
    .trim();
  return {
    ...cmd,
    args,
    display: `${withoutHost} --host ${h}`.trim(),
  };
}

/**
 * Comando de login interactivo por agente (fallback si no hay authMethod usable).
 * @param {string} agentId
 * @param {{ host?: string | null }} [opts] solo Copilot: host Enterprise opcional
 * @returns {LoginCommand | null}
 */
export function loginCommand(agentId, opts = {}) {
  switch (agentId) {
    case "claude":
      // `--cli` es del adaptador ACP, no del binario `claude` (falla: unknown option '--cli').
      return { bin: "claude", args: ["auth", "login"], display: "claude auth login" };
    case "copilot":
      return withCopilotLoginHost(
        { bin: "copilot", args: ["login"], display: "copilot login" },
        opts.host
      );
    case "cursor":
      return { bin: "cursor-agent", args: ["login"], display: "cursor-agent login" };
    default:
      return null;
  }
}

/**
 * Args de `claude auth login …` a partir de un authMethod ACP.
 * El adaptador anuncia `["--cli", "auth", "login", "--claudeai"]` (o lo mismo tras el path del
 * adapter en `_meta.terminal-auth.args`); `--cli` solo entiende el wrapper ACP, no `claude`.
 * @param {any} [method]
 * @returns {string[]}
 */
export function claudeCliLoginArgs(method) {
  const meta = method?._meta?.["terminal-auth"];
  const raw = Array.isArray(meta?.args)
    ? meta.args.map(String)
    : Array.isArray(method?.args)
      ? method.args.map(String)
      : [];
  const cliIdx = raw.indexOf("--cli");
  const after = cliIdx >= 0 ? raw.slice(cliIdx + 1) : raw;
  if (after[0] === "auth") return after;
  const flags = after.filter((a) => a.startsWith("--"));
  return ["auth", "login", ...flags];
}

/**
 * Clasifica un authMethod de `initialize` según ACP v1 + extensión Copilot `_meta.terminal-auth`.
 * @param {any} method
 * @returns {AuthMethodKind}
 */
export function classifyAuthMethod(method) {
  if (!method || typeof method.id !== "string" || !method.id) return "unknown";
  // Copilot / Claude-con-meta: `_meta.terminal-auth` gana aunque también traigan type.
  if (method._meta != null && method._meta["terminal-auth"] != null) return "terminal-meta";
  if (method.type === "terminal") return "terminal";
  if (!method.type || method.type === "agent") return "agent";
  return "unknown";
}

/**
 * @param {any[]} authMethods
 * @returns {{ agent: any[], terminal: any[], terminalMeta: any[], unknown: any[] }}
 */
export function groupAuthMethods(authMethods) {
  /** @type {{ agent: any[], terminal: any[], terminalMeta: any[], unknown: any[] }} */
  const groups = { agent: [], terminal: [], terminalMeta: [], unknown: [] };
  for (const method of authMethods || []) {
    const kind = classifyAuthMethod(method);
    if (kind === "agent") groups.agent.push(method);
    else if (kind === "terminal") groups.terminal.push(method);
    else if (kind === "terminal-meta") groups.terminalMeta.push(method);
    else groups.unknown.push(method);
  }
  return groups;
}

/** @param {string} text */
export function looksLikeAuthFailure(text) {
  const s = String(text || "").toLowerCase();
  return /(not\s+)?auth|login|unauthor|not logged|sign[\s-]?in|credentials|token.*(invalid|expired|missing)|please\s+run|auth_required/.test(
    s
  );
}

/**
 * Mensaje en español si el agente murió / falló por falta de login.
 * Sin comandos CLI: el CTA abre el login por el usuario.
 * @param {string} agentId
 * @param {string} agentLabel
 * @param {string} detail
 * @returns {string | null}
 */
export function authFailureMessage(agentId, agentLabel, detail) {
  if (!looksLikeAuthFailure(detail)) return null;
  const label = String(agentLabel || "").trim() || "el agente";
  return `Necesitás iniciar sesión en ${label}.`;
}

/** Fallo del proceso de login (exit ≠ 0 o cancelado a medias). */
export function loginIncompleteMessage() {
  return "No se pudo completar el inicio de sesión. Probá de nuevo.";
}

/** Estado mientras corre el login (TTY, proceso oculto o terminal externa). */
export function loginWaitingMessage() {
  return "Esperando que completes el inicio de sesión…";
}

/**
 * ¿El error pide login interactivo? (AcpAuthRequiredError o texto típico de auth).
 * @param {unknown} err
 */
export function isAuthRequiredError(err) {
  if (!err) return false;
  if (typeof err === "object" && /** @type {{ name?: string }} */ (err).name === "AcpAuthRequiredError") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return looksLikeAuthFailure(msg);
}

/**
 * authMethods de un AcpAuthRequiredError (si los trae).
 * @param {unknown} err
 * @returns {any[]}
 */
export function authMethodsFromError(err) {
  if (!err || typeof err !== "object") return [];
  const methods = /** @type {{ methods?: unknown }} */ (err).methods;
  return Array.isArray(methods) ? methods : [];
}

/**
 * Método interactivo a abrir: `_meta.terminal-auth` (Copilot) o `type: terminal` (Claude).
 * Si solo hay métodos `agent` (Cursor), devolvemos null → `resolveLoginCommand` usa el fallback CLI.
 * @param {any[]} [methods]
 * @returns {any | null}
 */
export function pickLoginAuthMethod(methods) {
  const grouped = groupAuthMethods(methods || []);
  return grouped.terminalMeta[0] ?? grouped.terminal[0] ?? null;
}

/**
 * Tras un fallo de auth: pregunta, abre el login (espera exit 0) y reintenta `op` una vez.
 * Con `priorError`, saltea el primer intento de `op` (ya falló el caller).
 * No duplica clasificación: reusa `pickLoginAuthMethod` / `resolveLoginCommand` / `runLoginTerminal`.
 *
 * @template T
 * @param {() => Promise<T>} op
 * @param {{
 *   agent: { def: { id: string, label: string, acp?: Function }, path: string },
 *   cwd?: string,
 *   priorError?: unknown,
 *   askToLogin: (info: { message: string, agentLabel: string, displayCmd: string }) => Promise<boolean>,
 *   pickCopilotHost?: () => Promise<string | null | undefined | false>,
 *   onStatus?: (msg: string) => void,
 *   runTerminal?: typeof runLoginTerminal,
 * }} opts
 * @returns {Promise<
 *   | { ok: true, value: T }
 *   | { ok: false, cancelled: true, error: unknown }
 *   | { ok: false, cancelled: false, error: unknown }
 * >}
 */
export async function withAgentLoginRetry(op, opts) {
  /** @type {unknown} */
  let err = opts.priorError;
  if (err === undefined) {
    try {
      return { ok: true, value: await op() };
    } catch (e) {
      err = e;
    }
  }

  if (!isAuthRequiredError(err)) {
    return { ok: false, cancelled: false, error: err };
  }

  const agentLabel = opts.agent?.def?.label || "El agente";
  const raw = err instanceof Error ? err.message : String(err);
  const fromAcp =
    typeof err === "object" &&
    err &&
    /** @type {{ name?: string }} */ (err).name === "AcpAuthRequiredError";
  const friendly =
    authFailureMessage(opts.agent?.def?.id || "", agentLabel, raw) ||
    (fromAcp ? `Necesitás iniciar sesión en ${agentLabel}.` : null) ||
    raw;
  const message =
    String(friendly).split(/\r?\n/)[0].trim() || `Necesitás iniciar sesión en ${agentLabel}.`;

  const method = pickLoginAuthMethod(authMethodsFromError(err));
  let cmd;
  try {
    cmd = resolveLoginCommand(opts.agent, method);
  } catch (resolveErr) {
    return { ok: false, cancelled: false, error: resolveErr };
  }

  let want = false;
  try {
    want = Boolean(await opts.askToLogin({ message, agentLabel, displayCmd: cmd.display }));
  } catch {
    want = false;
  }
  if (!want) {
    return { ok: false, cancelled: true, error: err };
  }

  if (opts.agent?.def?.id === "copilot" && typeof opts.pickCopilotHost === "function") {
    let hostPick;
    try {
      hostPick = await opts.pickCopilotHost();
    } catch {
      return { ok: false, cancelled: true, error: err };
    }
    if (hostPick === false) {
      return { ok: false, cancelled: true, error: err };
    }
    cmd = withCopilotLoginHost(cmd, hostPick);
  }

  opts.onStatus?.(loginWaitingMessage());
  const run = opts.runTerminal || runLoginTerminal;
  let result;
  try {
    result = await run(cmd, { wait: true, cwd: opts.cwd });
  } catch (loginErr) {
    return { ok: false, cancelled: false, error: loginErr };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      cancelled: false,
      error: new Error(loginIncompleteMessage()),
    };
  }

  opts.onStatus?.("Login ok. Reintentando…");
  try {
    return { ok: true, value: await op() };
  } catch (retryErr) {
    return { ok: false, cancelled: false, error: retryErr };
  }
}

/**
 * ¿Podemos correr el login en la misma terminal (stdio inherit)?
 * La web / procesos sin TTY usan proceso oculto (o `external: true` → ventana).
 * @param {{ external?: boolean }} [opts]
 */
export function canInheritLoginTty(opts = {}) {
  if (opts.external) return false;
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
}

/**
 * Modo de launch: inherit (CLI con TTY) → hidden (web / OAuth en browser) → external (forzado).
 * @param {{ wait?: boolean, external?: boolean }} [opts]
 * @returns {LoginLaunchMode}
 */
export function resolveLoginLaunchMode(opts = {}) {
  if (Boolean(opts.wait) && canInheritLoginTty(opts)) return "inherit";
  if (opts.external) return "external";
  return "hidden";
}

/**
 * Arma el comando de login a partir de un authMethod (o fallback por agentId).
 * @param {{ def: { id: string, acp?: Function }, path: string }} agent
 * @param {any} [method]
 * @returns {LoginCommand}
 */
export function resolveLoginCommand(agent, method) {
  const kind = method ? classifyAuthMethod(method) : "unknown";
  const meta = method?._meta?.["terminal-auth"];

  // Claude: preferir el CLI real (`claude auth login …`). Lanzar npx/adapter + `--cli` falla o es
  // frágil en Windows; el meta `node + adapter --cli …` funciona pero es un rodeos innecesario.
  if (
    agent?.def?.id === "claude" &&
    method &&
    (kind === "terminal" || kind === "terminal-meta")
  ) {
    const args = claudeCliLoginArgs(method);
    const bin = typeof agent.path === "string" && agent.path.trim() ? agent.path : "claude";
    return {
      bin,
      args,
      display: `claude ${args.join(" ")}`.trim(),
      ...(method?.env && typeof method.env === "object" ? { env: method.env } : {}),
    };
  }

  if ((kind === "terminal-meta" || kind === "terminal") && meta && typeof meta === "object") {
    const command = typeof meta.command === "string" ? meta.command.trim() : "";
    if (command) {
      const args = Array.isArray(meta.args) ? meta.args.map(String) : [];
      const label = typeof meta.label === "string" && meta.label.trim() ? meta.label.trim() : "";
      return {
        bin: command,
        args,
        display: label || `${command}${args.length ? ` ${args.join(" ")}` : ""}`.trim(),
        ...(method?.env && typeof method.env === "object" ? { env: method.env } : {}),
      };
    }
  }

  if (kind === "terminal" && method && typeof agent?.def?.acp === "function") {
    const launch = agent.def.acp({ path: agent.path });
    const extra = Array.isArray(method.args) ? method.args.map(String) : [];
    const env = {
      ...(launch.env && typeof launch.env === "object" ? launch.env : {}),
      ...(method.env && typeof method.env === "object" ? method.env : {}),
    };
    const args = [...(launch.args || []), ...extra];
    return {
      bin: launch.file,
      args,
      display: `${launch.file}${args.length ? ` ${args.join(" ")}` : ""}`.trim(),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }

  const fallback = loginCommand(agent?.def?.id);
  if (fallback) {
    if (agent?.def?.id === "claude" && typeof agent.path === "string" && agent.path.trim()) {
      return { ...fallback, bin: agent.path };
    }
    return fallback;
  }
  throw new Error("Este agente no tiene un inicio de sesión conocido.");
}

/** @param {import('node:child_process').ChildProcess} child */
function waitExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

/**
 * Lanza el login en background (proceso oculto; no espera). Compat con UI/CTA simples (web sin sesión).
 * @param {string | LoginCommand} agentIdOrCmd
 * @returns {{ display: string }}
 */
export function openLoginTerminal(agentIdOrCmd) {
  const cmd = typeof agentIdOrCmd === "string" ? loginCommand(agentIdOrCmd) : agentIdOrCmd;
  if (!cmd) {
    const agentId = typeof agentIdOrCmd === "string" ? agentIdOrCmd : "";
    throw new Error(
      agentId === "cursor"
        ? "Necesitás iniciar sesión en Cursor."
        : "Este agente no tiene un inicio de sesión conocido."
    );
  }
  void launchLoginProcess(cmd, { wait: false, mode: "hidden" });
  return { display: cmd.display };
}

/**
 * Lanza el login. Con TTY y `wait: true`, corre en esta terminal (inherit); si no, proceso oculto
 * (OAuth en browser). Solo con `external: true` abre una ventana de terminal del OS.
 * @param {LoginCommand} cmd
 * @param {{ wait?: boolean, cwd?: string, external?: boolean }} [opts]
 * @returns {Promise<{ display: string, code: number | null, mode: LoginLaunchMode }>}
 */
export async function runLoginTerminal(cmd, opts = {}) {
  const wait = Boolean(opts.wait);
  const mode = resolveLoginLaunchMode(opts);
  const code = await launchLoginProcess(cmd, {
    wait,
    cwd: opts.cwd,
    mode,
  });
  return {
    display: cmd.display,
    code: wait ? code : null,
    mode,
  };
}

/** @param {string} arg */
function quoteBatArg(arg) {
  const s = String(arg);
  if (/^[\w./:\\@=-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Espera a que el sentinel tenga un exit code (macOS/Linux/Windows externo).
 * @param {string} sentinel
 * @param {string} display
 * @returns {Promise<number>}
 */
async function waitForExitSentinel(sentinel, display) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(sentinel, "utf8").trim();
      if (raw !== "") {
        const code = Number.parseInt(raw, 10);
        try {
          unlinkSync(sentinel);
        } catch {
          /* ignore */
        }
        return Number.isFinite(code) ? code : 1;
      }
    } catch {
      /* aún no */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  try {
    unlinkSync(sentinel);
  } catch {
    /* ignore */
  }
  throw new Error(`Timeout esperando el login (${display}).`);
}

/**
 * Proceso hijo sin ventana de terminal (web / OAuth). Exit code real vía waitExit.
 * @param {LoginCommand} cmd
 * @param {{ wait: boolean, cwd?: string, env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<number>}
 */
async function launchHiddenLogin(cmd, { wait, cwd, env }) {
  const child = spawnCommand(cmd.bin, cmd.args, {
    cwd,
    env,
    stdio: "ignore",
    windowsHide: true,
    ...(wait ? {} : { detached: true }),
  });
  if (!wait) {
    child.unref();
    return 0;
  }
  return waitExit(child);
}

/**
 * @param {LoginCommand} cmd
 * @param {{ wait: boolean, cwd?: string, mode: LoginLaunchMode }} opts
 * @returns {Promise<number>}
 */
async function launchLoginProcess(cmd, { wait, cwd, mode }) {
  const env = { ...process.env, ...(cmd.env || {}) };

  if (mode === "inherit") {
    const child = spawnCommand(cmd.bin, cmd.args, { cwd, env, stdio: "inherit" });
    return waitExit(child);
  }

  if (mode === "hidden") {
    return launchHiddenLogin(cmd, { wait, cwd, env });
  }

  // mode === "external": ventana visible del OS (solo si el caller pasó external: true).
  const platform = process.platform;

  if (platform === "win32") {
    if (!wait) {
      const child = spawn(
        "cmd.exe",
        ["/c", "start", "diff-review login", "cmd.exe", "/k", cmd.bin, ...cmd.args],
        { cwd, env, detached: true, stdio: "ignore", windowsHide: false }
      );
      child.unref();
      return 0;
    }

    // `start /wait` siempre reporta 0 a Node: el exit real va al sentinel vía .bat.
    const id = randomBytes(8).toString("hex");
    const sentinel = join(tmpdir(), `diff-review-login-${id}.exit`);
    const bat = join(tmpdir(), `diff-review-login-${id}.bat`);
    const line = [quoteBatArg(cmd.bin), ...cmd.args.map(quoteBatArg)].join(" ");
    // No usar `echo %ERRORLEVEL%>file`: con código 0, cmd interpreta `echo 0>` y el sentinel queda vacío.
    const sentPath = sentinel.replace(/"/g, '""');
    writeFileSync(
      bat,
      [`@echo off`, `call ${line}`, `> "${sentPath}" echo %ERRORLEVEL%`, ``].join("\r\n")
    );
    try {
      writeFileSync(sentinel, "");
    } catch {
      /* ok */
    }
    const child = spawn(
      "cmd.exe",
      ["/c", "start", "/wait", "diff-review login", "cmd.exe", "/c", bat],
      { cwd, env, stdio: "ignore", windowsHide: false }
    );
    try {
      await waitExit(child);
      return await waitForExitSentinel(sentinel, cmd.display);
    } finally {
      try {
        unlinkSync(bat);
      } catch {
        /* ignore */
      }
    }
  }

  if (!wait) {
    if (platform === "darwin") {
      const script = `tell application "Terminal" to do script ${JSON.stringify(`${cmd.bin} ${cmd.args.join(" ")}`.trim())}`;
      spawn("osascript", ["-e", script], { detached: true, stdio: "ignore", env }).unref();
      return 0;
    }
    const line = `${cmd.bin} ${cmd.args.join(" ")}`.trim();
    const tried = [
      ["x-terminal-emulator", ["-e", "bash", "-lc", `${line}; exec bash`]],
      ["gnome-terminal", ["--", "bash", "-lc", `${line}; exec bash`]],
      ["konsole", ["-e", "bash", "-lc", `${line}; exec bash`]],
      ["xterm", ["-e", "bash", "-lc", `${line}; exec bash`]],
    ];
    for (const [bin, args] of tried) {
      try {
        spawn(bin, args, { detached: true, stdio: "ignore", env, cwd }).unref();
        return 0;
      } catch {
        /* siguiente */
      }
    }
    throw new Error(`No pude abrir una terminal. Corré a mano: ${cmd.display}`);
  }

  // wait=true en macOS/Linux: terminal externa + sentinel.
  const sentinel = join(tmpdir(), `diff-review-login-${randomBytes(8).toString("hex")}.exit`);
  try {
    writeFileSync(sentinel, "");
  } catch {
    /* ok */
  }
  const quoted = [cmd.bin, ...cmd.args].map((a) => JSON.stringify(a)).join(" ");
  const line = `${quoted}; echo $? > ${JSON.stringify(sentinel)}`;

  if (platform === "darwin") {
    const script = `tell application "Terminal" to do script ${JSON.stringify(line)}`;
    spawn("osascript", ["-e", script], { stdio: "ignore", env, cwd });
  } else {
    const tried = [
      ["gnome-terminal", ["--wait", "--", "bash", "-lc", line]],
      ["x-terminal-emulator", ["-e", "bash", "-lc", line]],
      ["konsole", ["-e", "bash", "-lc", line]],
      ["xterm", ["-e", "bash", "-lc", line]],
    ];
    let ok = false;
    for (const [bin, args] of tried) {
      try {
        const child = spawn(bin, args, { stdio: "ignore", env, cwd });
        await waitExit(child);
        ok = true;
        break;
      } catch {
        /* siguiente */
      }
    }
    if (!ok) throw new Error(`No pude abrir una terminal. Corré a mano: ${cmd.display}`);
  }

  return waitForExitSentinel(sentinel, cmd.display);
}

/**
 * Cuenta activa del agente (para el header de la web).
 * @param {string} agentId
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof spawnSync }} [opts]
 * @returns {{
 *   agentId: string,
 *   loggedIn: boolean,
 *   accountLabel: string | null,
 *   detail: string | null,
 *   source: 'gh' | 'claude' | 'env' | 'unknown' | null,
 *   warnings: string[],
 * }}
 */
export function agentAccountStatus(agentId, opts = {}) {
  const id = String(agentId || "").trim();
  const env = opts.env || process.env;
  const run = opts.run || spawnSync;
  /** @type {string[]} */
  const warnings = [];

  if (id === "copilot") {
    const envHits = copilotTokenEnvOverrides(env);
    if (envHits.length) {
      warnings.push(`${envHits.join(", ")} en el entorno (pisa otras cuentas).`);
      return {
        agentId: id,
        loggedIn: true,
        accountLabel: "Token de entorno",
        detail: envHits.join(", "),
        source: "env",
        warnings,
      };
    }
    const accounts = listGhAuthAccounts({ env, run });
    const active = accounts.find((a) => a.active) || accounts[0] || null;
    if (active) {
      return {
        agentId: id,
        loggedIn: true,
        accountLabel: active.user,
        detail: active.host,
        source: "gh",
        warnings,
      };
    }
    return {
      agentId: id,
      loggedIn: false,
      accountLabel: null,
      detail: null,
      source: null,
      warnings,
    };
  }

  if (id === "claude") {
    const r = run("claude", ["auth", "status", "--json"], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });
    if (r.error) {
      return {
        agentId: id,
        loggedIn: false,
        accountLabel: null,
        detail: null,
        source: null,
        warnings: [r.error.message],
      };
    }
    try {
      const parsed = JSON.parse(String(r.stdout || "{}"));
      const loggedIn = Boolean(parsed?.loggedIn);
      const email = String(parsed?.email || "").trim() || null;
      const org = String(parsed?.orgName || "").trim() || null;
      return {
        agentId: id,
        loggedIn,
        accountLabel: loggedIn ? email || "Claude" : null,
        detail: loggedIn ? org || String(parsed?.authMethod || "") || null : null,
        source: loggedIn ? "claude" : null,
        warnings,
      };
    } catch {
      return {
        agentId: id,
        loggedIn: false,
        accountLabel: null,
        detail: null,
        source: null,
        warnings: ["No pude leer el estado de Claude."],
      };
    }
  }

  if (id === "cursor") {
    return {
      agentId: id,
      loggedIn: true,
      accountLabel: "Cursor",
      detail: "Sesión del CLI / app",
      source: "unknown",
      warnings,
    };
  }

  return {
    agentId: id,
    loggedIn: false,
    accountLabel: null,
    detail: null,
    source: null,
    warnings,
  };
}

/**
 * Env vars que Copilot usa antes que OAuth / gh (impiden un cambio de cuenta real).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function copilotTokenEnvOverrides(env = process.env) {
  /** @type {string[]} */
  const hit = [];
  for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    if (String(env[key] || "").trim()) hit.push(key);
  }
  return hit;
}

/**
 * Cuentas conocidas por `gh auth status --json hosts`.
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof spawnSync }} [opts]
 * @returns {{ host: string, user: string, active: boolean }[]}
 */
export function listGhAuthAccounts(opts = {}) {
  const env = opts.env || process.env;
  const run = opts.run || spawnSync;
  const r = run("gh", ["auth", "status", "--json", "hosts"], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  if (r.error) return [];
  try {
    const parsed = JSON.parse(String(r.stdout || "{}"));
    const hosts = parsed?.hosts && typeof parsed.hosts === "object" ? parsed.hosts : {};
    /** @type {{ host: string, user: string, active: boolean }[]} */
    const out = [];
    for (const [host, accounts] of Object.entries(hosts)) {
      const list = Array.isArray(accounts) ? accounts : [];
      for (const acc of list) {
        const user = String(acc?.login || acc?.user || "").trim();
        if (!user) continue;
        out.push({ host: String(host), user, active: Boolean(acc?.active) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Cierra sesiones de `gh` (Copilot las reusa si no hay OAuth propio).
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof spawnSync, host?: string | null }} [opts]
 * @returns {{ ok: boolean, loggedOut: { host: string, user: string }[], warnings: string[] }}
 */
export function logoutGhAuthAccounts(opts = {}) {
  const env = opts.env || process.env;
  const run = opts.run || spawnSync;
  const onlyHost = normalizeCopilotLoginHost(opts.host) || null;
  const accounts = listGhAuthAccounts({ env, run }).filter((a) =>
    onlyHost ? a.host === onlyHost || a.host === `https://${onlyHost}` : true
  );
  /** @type {{ host: string, user: string }[]} */
  const loggedOut = [];
  /** @type {string[]} */
  const warnings = [];

  for (const acc of accounts) {
    const r = run(
      "gh",
      ["auth", "logout", "--hostname", acc.host, "--user", acc.user],
      { encoding: "utf8", env, windowsHide: true }
    );
    if (r.error) {
      warnings.push(`No pude cerrar ${acc.user}@${acc.host}: ${r.error.message}`);
      continue;
    }
    if (r.status !== 0) {
      const err = String(r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
      warnings.push(`No pude cerrar ${acc.user}@${acc.host}: ${err}`);
      continue;
    }
    loggedOut.push({ host: acc.host, user: acc.user });
  }

  const envHits = copilotTokenEnvOverrides(env);
  if (envHits.length) {
    warnings.push(
      `Hay ${envHits.join(", ")} en el entorno: Copilot seguirá usando ese token hasta que lo saques.`
    );
  }

  return { ok: warnings.length === 0 || loggedOut.length > 0, loggedOut, warnings };
}

/**
 * Comando de logout CLI por agente (sin depender de gh).
 * @param {string} agentId
 * @returns {LoginCommand | null}
 */
export function logoutCommand(agentId) {
  switch (agentId) {
    case "claude":
      return { bin: "claude", args: ["auth", "logout"], display: "claude auth logout" };
    default:
      return null;
  }
}

/**
 * Cierra la sesión del agente para poder elegir otra cuenta.
 * Copilot: también desloguea cuentas de `gh` (si solo hacés logout OAuth, gh sigue ganando).
 *
 * @param {string} agentId
 * @param {{
 *   host?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   run?: typeof spawnSync,
 *   runTerminal?: typeof runLoginTerminal,
 *   cwd?: string,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, steps: string[], warnings: string[] }>}
 */
export async function runAgentLogout(agentId, opts = {}) {
  const id = String(agentId || "").trim();
  /** @type {string[]} */
  const steps = [];
  /** @type {string[]} */
  const warnings = [];
  const env = opts.env || process.env;
  const run = opts.run || spawnSync;
  const runTerm = opts.runTerminal || runLoginTerminal;

  if (id === "copilot") {
    const gh = logoutGhAuthAccounts({ env, run, host: opts.host });
    for (const a of gh.loggedOut) {
      steps.push(`Cerré ${a.user} en ${a.host} (GitHub CLI)`);
    }
    warnings.push(...gh.warnings);
    if (!gh.loggedOut.length && !gh.warnings.length) {
      steps.push("No había cuentas de GitHub CLI activas.");
    }
    return { ok: true, steps, warnings };
  }

  const cmd = logoutCommand(id);
  if (!cmd) {
    return {
      ok: false,
      steps,
      warnings: ["Este agente no tiene cierre de sesión desde la app."],
    };
  }

  try {
    const result = await runTerm(cmd, { wait: true, cwd: opts.cwd });
    if (result.code !== 0) {
      warnings.push(`El logout terminó con código ${result.code ?? "?"}.`);
      return { ok: false, steps, warnings };
    }
    steps.push(`Cerré la sesión (${cmd.display}).`);
    return { ok: true, steps, warnings };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
    return { ok: false, steps, warnings };
  }
}
