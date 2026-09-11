import { execFile, execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactDiff,
  formatGuidelines,
  isTestPath,
  loadReviewConfig,
  modelSlice,
  PROMPT_BATCH_CHARS,
  PROMPT_BATCH_FILES,
} from "./config.mjs";
import { flattenFiles } from "./extract.mjs";
import { decodePayload } from "./json-payload.mjs";
import { applySynthesis, buildReview, countHunks, mergeReviewPayloads } from "./review.mjs";
import {
  jsonContract,
  REVIEW_SCHEMA,
  reviewIssues,
  SYNTHESIS_SCHEMA,
  synthesisContract,
  validateAgainst,
} from "./validate.mjs";

export const AGENT_ORDER = ["claude", "cursor", "copilot"];

/** Max concurrent CLI subprocesses (batches in parallel share this pool). */
export const CLI_SLOT_LIMIT = 2;
export const BATCH_CONCURRENCY = 2;

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) queue.shift()?.();
  };
  return {
    async acquire(signal) {
      if (signal?.aborted) throw cancelledError();
      if (active < limit) {
        active += 1;
        return () => {
          active -= 1;
          drain();
        };
      }
      await new Promise((resolve, reject) => {
        const waiter = () => {
          if (signal?.aborted) {
            reject(cancelledError());
            return;
          }
          if (active < limit) {
            active += 1;
            resolve(() => {
              active -= 1;
              drain();
            });
          } else {
            queue.push(waiter);
          }
        };
        waiter();
      });
    },
  };
}

const cliSemaphore = createSemaphore(CLI_SLOT_LIMIT);

async function runPool(count, concurrency, worker) {
  const results = new Array(count);
  let next = 0;
  async function runWorker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= count) return;
      results[i] = await worker(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => runWorker()));
  return results;
}

/** Same order as the Cursor IDE model picker. Only shown if `agent --list-models` has the id. */
const CURSOR_FEATURED = [
  { id: "default", label: "Auto", group: "auto" },
  { id: "cursor-grok-4.6-high", label: "Cursor Grok 4.6", suffix: "High", group: "cursor" },
  { id: "composer-2.5-fast", label: "Composer 2.5", suffix: "Fast", group: "cursor" },
  { id: "cursor-grok-4.5-high-fast", label: "Cursor Grok 4.5", suffix: "High Fast", group: "cursor" },
  { id: "claude-opus-5-high", label: "Claude Opus 5", suffix: "High", group: "other" },
  { id: "gpt-5.6-sol-medium", label: "GPT-5.6 Sol", suffix: "Medium", group: "other" },
  { id: "claude-4.5-opus-high", label: "Claude Opus 4.5", group: "other" },
];

const CLAUDE_ALIASES = new Set(["sonnet", "opus", "haiku", "fable"]);

const FALLBACK_MODELS = {
  claude: [
    { id: "default", label: "Default del CLI" },
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
    { id: "haiku", label: "Haiku" },
    { id: "fable", label: "Fable" },
  ],
  cursor: CURSOR_FEATURED,
  copilot: [
    { id: "default", label: "Default del CLI (auto)" },
    { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  ],
};

export function agentLabel(agent) {
  if (agent === "cursor") return "Cursor";
  if (agent === "copilot") return "Copilot";
  return "Claude";
}

export function isAgentId(value) {
  return AGENT_ORDER.includes(value);
}

function logReview(...parts) {
  console.log("[diff-review]", ...parts);
}

function subscriptionEnv() {
  const env = { ...process.env };
  // A key de Console cobra por token y pisa la suscripción de Claude Code.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function isConfigLockError(err) {
  const msg = String(err?.message || err);
  return /EPERM|EACCES|EBUSY/i.test(msg) && /cli-config\.json/i.test(msg);
}

function findRgDirs() {
  const dirs = [];
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  const localApp = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const versionsRoot = join(localApp, "cursor-agent", "versions");
  if (existsSync(versionsRoot)) {
    try {
      for (const ent of readdirSync(versionsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const dir = join(versionsRoot, ent.name);
        if (existsSync(join(dir, name))) dirs.push(dir);
      }
    } catch {
      // ignore
    }
  }
  const ideRg = join(
    localApp,
    "Programs",
    "cursor",
    "resources",
    "app",
    "node_modules",
    "@vscode",
    "ripgrep",
    "bin",
  );
  if (existsSync(join(ideRg, name))) dirs.push(ideRg);
  const fromPath = resolveBin("rg");
  if (fromPath) dirs.push(dirname(fromPath));
  return [...new Set(dirs)];
}

function withRgOnPath(env) {
  const dirs = findRgDirs();
  if (!dirs.length) return env;
  // Windows uses `Path`; setting only `PATH` leaves the original key and `which rg` fails.
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  env[key] = [...dirs, env[key] || ""].filter(Boolean).join(delimiter);
  return env;
}

/**
 * Cursor IDE locks ~/.cursor/cli-config.json on Windows; `agent` then fails
 * renaming cli-config.json.tmp. Give the CLI its own copy.
 */
function cursorCliEnv() {
  const env = withRgOnPath(subscriptionEnv());
  const srcDir = join(homedir(), ".cursor");
  const src = join(srcDir, "cli-config.json");
  const dir = join(srcDir, "diff-review-cli");
  mkdirSync(dir, { recursive: true });
  try {
    rmSync(join(dir, "cli-config.json.tmp"), { force: true });
  } catch {
    // ignore
  }
  if (existsSync(src)) {
    try {
      copyFileSync(src, join(dir, "cli-config.json"));
    } catch {
      // keep whatever copy we already have
    }
  }
  env.CURSOR_CONFIG_DIR = dir;
  return env;
}

export function apiKeyWouldBillExtra() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function extraBinCandidates(name) {
  const localApp = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [];
  if (name === "agent") {
    const versionsRoot = join(localApp, "cursor-agent", "versions");
    if (existsSync(versionsRoot)) {
      try {
        for (const ent of readdirSync(versionsRoot, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const bin = join(versionsRoot, ent.name, exe);
          if (existsSync(bin)) candidates.push(bin);
        }
      } catch {
        // ignore
      }
    }
    candidates.push(join(localApp, "cursor-agent", exe));
  }
  if (name === "copilot") {
    candidates.push(
      join(localApp, "Microsoft", "WinGet", "Links", exe),
      join(localApp, "GitHub CLI", "copilot", exe),
      join(homedir(), ".local", "bin", exe),
    );
    const pkgRoot = join(localApp, "Microsoft", "WinGet", "Packages");
    if (existsSync(pkgRoot)) {
      try {
        for (const ent of readdirSync(pkgRoot, { withFileTypes: true })) {
          if (!ent.isDirectory() || !/^GitHub\.Copilot/i.test(ent.name)) continue;
          const bin = join(pkgRoot, ent.name, exe);
          if (existsSync(bin)) candidates.push(bin);
        }
      } catch {
        // ignore
      }
    }
  }
  return candidates.filter((p) => existsSync(p));
}

function resolveBin(name) {
  const extras = extraBinCandidates(name);
  const extraExe = extras.find((p) => p.toLowerCase().endsWith(".exe")) || extras[0] || null;
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const stdout = execFileSync(cmd, [name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const lower = (s) => s.toLowerCase();
    const fromPath =
      lines.find((l) => lower(l).endsWith(".exe")) ||
      lines.find((l) => lower(l).endsWith(".cmd")) ||
      lines[0] ||
      null;
    if (fromPath) {
      if (lower(fromPath).endsWith(".cmd") && extraExe && extraExe.toLowerCase().endsWith(".exe")) {
        return extraExe;
      }
      return fromPath;
    }
  } catch {
    // try extra locations
  }
  return extraExe;
}

function fileLooksLoggedIn(paths) {
  return paths.some((p) => existsSync(p));
}

function spawnBin(bin, args, options) {
  const isCmd = process.platform === "win32" && /\.cmd$/i.test(bin);
  if (isCmd) {
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", bin, ...args], options);
  }
  return spawn(bin, args, options);
}

function isBenignPipeError(err) {
  const code = err?.code;
  return code === "EOF" || code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED";
}

function guardChildStdio(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on("error", (err) => {
      if (isBenignPipeError(err)) return;
      logReview("stdio", err.code || "", err.message);
    });
  }
}

function feedStdin(child, text) {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) return;
  try {
    stdin.end(text ?? "", "utf8");
  } catch (err) {
    if (!isBenignPipeError(err)) logReview("stdin", err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cancelledError(message = "Cancelado") {
  const err = new Error(message);
  err.code = "CANCELLED";
  return err;
}

export function isCancelled(err) {
  return Boolean(err && (err.code === "CANCELLED" || /cancel/i.test(err.message || "")));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

function runCliCapture(bin, args, { env, timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnBin(bin, args, {
      env: env || subscriptionEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    guardChildStdio(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      done(-1);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => done(-1));
    child.on("close", (code) => done(code ?? 0));
  });
}

function uniqModels(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const next = { id, label: String(item.label || id).trim() || id };
    if (item.suffix) next.suffix = String(item.suffix).trim();
    if (item.group) next.group = String(item.group).trim();
    out.push(next);
  }
  return out;
}

function arrangeCursorModels(list) {
  const byId = new Map(uniqModels(list).map((item) => [item.id, item]));
  if (!byId.has("default")) byId.set("default", { id: "default", label: "Auto" });
  const out = [];
  const used = new Set();
  for (const pin of CURSOR_FEATURED) {
    if (!byId.has(pin.id)) continue;
    out.push({
      id: pin.id,
      label: pin.label,
      group: pin.group,
      ...(pin.suffix ? { suffix: pin.suffix } : {}),
    });
    used.add(pin.id);
  }
  for (const item of byId.values()) {
    if (used.has(item.id)) continue;
    out.push({ id: item.id, label: item.label, group: "more" });
  }
  return out;
}

function parseClaudeModels(text) {
  const models = [...FALLBACK_MODELS.claude];
  const quoted = [...String(text).matchAll(/'([a-z][a-z0-9-]{2,})'/gi)].map((m) => m[1].toLowerCase());
  for (const id of quoted) {
    if (["default", "auto", "true", "false", "json"].includes(id)) continue;
    if (CLAUDE_ALIASES.has(id) || /^(sonnet|opus|haiku|fable|claude-)/.test(id)) {
      models.push({ id, label: id });
    }
  }
  return uniqModels(models);
}

function parseCursorModels(text) {
  const models = [{ id: "default", label: "Default del CLI" }];
  const seen = new Set(["default"]);
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([a-z0-9][\w.+[\]=,:-]*)\s+-\s+(.+)$/i);
    if (!m) continue;
    const id = m[1];
    const label = m[2].replace(/\s+\(default\)\s*$/i, "").trim();
    if (id === "auto") {
      models[0] = { id: "default", label: label || "Auto" };
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models.length > 1 ? arrangeCursorModels(models) : null;
}

function parseCopilotModels(text) {
  const ids = [];
  const choiceBlock = String(text).match(/choices:\s*"([^"]+)"(?:\s*,\s*"([^"]+)")*/i);
  if (choiceBlock) {
    ids.push(...[...String(text).matchAll(/"([a-z0-9][a-z0-9. _-]*)"/gi)].map((m) => m[1]));
  }
  const models = [{ id: "default", label: "Default del CLI (auto)" }];
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || id === "auto" || id === "default" || id.length < 3) continue;
    if (!/^(gpt-|claude-|gemini-|o\d)/i.test(id) && !/codex/i.test(id)) continue;
    models.push({ id, label: id });
  }
  return models.length > 1 ? uniqModels(models) : null;
}

async function listModels(agent, bin) {
  const fallback = FALLBACK_MODELS[agent] || FALLBACK_MODELS.claude;
  if (!bin) return fallback;
  try {
    if (agent === "cursor") {
      const { stdout, stderr } = await runCliCapture(bin, ["--list-models"], {
        env: cursorCliEnv(),
        timeoutMs: 20000,
      });
      return parseCursorModels(`${stdout}\n${stderr}`) || fallback;
    }
    if (agent === "claude") {
      const { stdout, stderr } = await runCliCapture(bin, ["--help"], { timeoutMs: 10000 });
      return parseClaudeModels(`${stdout}\n${stderr}`);
    }
    if (agent === "copilot") {
      const { stdout, stderr } = await runCliCapture(bin, ["--help"], { timeoutMs: 12000 });
      return parseCopilotModels(`${stdout}\n${stderr}`) || fallback;
    }
  } catch (err) {
    logReview("models", agent, String(err?.message || err).slice(0, 160));
  }
  return fallback;
}

function detectAgentBins() {
  const claudeBin = resolveBin("claude");
  const cursorBin = resolveBin("agent");
  const copilotBin = resolveBin("copilot");
  const apiKeyWarning = apiKeyWouldBillExtra()
    ? "Hay ANTHROPIC_API_KEY en el entorno. La vamos a ignorar para no cobrar API; usamos la suscripción del CLI."
    : null;

  const claudeLoggedIn = fileLooksLoggedIn([
    join(homedir(), ".claude", ".credentials.json"),
    join(homedir(), ".claude.json"),
  ]);
  const copilotLoggedIn = fileLooksLoggedIn([
    join(homedir(), ".copilot", "config.json"),
    join(homedir(), ".copilot", "session-store.db"),
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "github-copilot", "apps.json"),
  ]);

  return {
    apiKeyWarning,
    claude: {
      id: "claude",
      label: "Claude",
      bin: claudeBin,
      installed: Boolean(claudeBin),
      loggedIn: Boolean(claudeBin),
      loginHint: "En una terminal: claude   (abre el browser, login con claude.ai / Pro)",
      detail: claudeBin
        ? (claudeLoggedIn ? "CLI listo, descuenta Claude Pro" : "Instalado. Si falla: claude")
        : "No está en el PATH",
    },
    cursor: {
      id: "cursor",
      label: "Cursor",
      bin: cursorBin,
      installed: Boolean(cursorBin),
      loggedIn: Boolean(cursorBin),
      loginHint: "En una terminal: agent login",
      detail: cursorBin ? "CLI listo, descuenta Cursor Pro" : "No está en el PATH",
    },
    copilot: {
      id: "copilot",
      label: "GitHub Copilot",
      bin: copilotBin,
      installed: Boolean(copilotBin),
      loggedIn: Boolean(copilotBin),
      loginHint: "En una terminal: copilot login   (cuenta de GitHub Copilot)",
      detail: copilotBin
        ? (copilotLoggedIn ? "CLI listo, descuenta Copilot" : "Instalado. Si falla: copilot login")
        : "No está en el PATH. winget install GitHub.Copilot",
    },
  };
}

export async function getAgentStatuses() {
  const base = detectAgentBins();
  const [claudeModels, cursorModels, copilotModels] = await Promise.all([
    listModels("claude", base.claude.bin),
    listModels("cursor", base.cursor.bin),
    listModels("copilot", base.copilot.bin),
  ]);
  return {
    apiKeyWarning: base.apiKeyWarning,
    claude: { ...base.claude, models: claudeModels },
    cursor: { ...base.cursor, models: cursorModels },
    copilot: { ...base.copilot, models: copilotModels },
  };
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isAgentEnvelope(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      obj.type === "result" &&
      (obj.subtype != null || obj.session_id != null || obj.duration_ms != null),
  );
}

/** Los CLI envuelven la respuesta en un JSON de sesión; adentro viene el texto del modelo. */
function unwrapEnvelope(stdout) {
  const trimmed = String(stdout || "").trim();
  const parsed = tryParseJson(trimmed);
  if (!isAgentEnvelope(parsed)) return trimmed;
  const inner = parsed.result;
  if (typeof inner === "string") return inner.trim();
  if (inner && typeof inner === "object") return JSON.stringify(inner);
  throw new Error("El agente devolvió un envelope vacío (no leyó el pedido).");
}

function extractCopilotText(stdout) {
  const trimmed = String(stdout || "").trim();
  const lines = trimmed.split(/\r?\n/);
  let last = "";
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    const obj = tryParseJson(t);
    if (!obj) continue;
    const pieces = [
      obj.result,
      obj.data?.result,
      obj.data?.text,
      obj.data?.content,
      obj.data?.message?.content,
      obj.message?.content,
      obj.data?.response,
    ];
    for (const piece of pieces) {
      if (typeof piece === "string" && piece.trim()) last = piece;
      if (Array.isArray(piece)) {
        const joined = piece
          .map((x) => (typeof x === "string" ? x : x?.text || x?.content || ""))
          .filter(Boolean)
          .join("\n");
        if (joined) last = joined;
      }
    }
  }
  return last || trimmed;
}

function extractUsage(stdout, agent) {
  const trimmed = String(stdout || "").trim();
  const parsed = tryParseJson(trimmed);
  if (!parsed || typeof parsed !== "object") return null;
  const usage = parsed.usage || parsed.data?.usage || parsed.result?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens;
  if (input == null && output == null) return null;
  return {
    inputTokens: Number(input) || 0,
    outputTokens: Number(output) || 0,
    agent,
  };
}

function parseAgentRun(agent, stdout) {
  const text = agent === "copilot" ? extractCopilotText(stdout) : unwrapEnvelope(stdout);
  if (!String(text || "").trim()) throw new Error("El agente no devolvió texto.");
  return {
    payload: decodePayload(text),
    responseText: String(text || ""),
    responseChars: String(stdout || "").length,
    usage: extractUsage(stdout, agent),
  };
}

function modelArgs(model) {
  const value = String(model || "").trim();
  if (!value || value === "default") return [];
  return ["--model", value];
}

function copilotArgs(model, instruction, extra = {}) {
  // -p requires --allow-all-tools so the CLI does not hang asking permission.
  // That is NOT --yolo/--allow-all: shell/write/url stay denied and excluded.
  const args = [
    "-p",
    instruction,
    "-s",
    "--no-ask-user",
    "--disable-builtin-mcps",
    "--allow-all-tools",
    "--deny-tool",
    "shell",
    "--deny-tool",
    "write",
    "--deny-tool",
    "url",
    "--excluded-tools",
    "shell,write,url",
    ...modelArgs(model),
  ];
  if (extra.addDir) args.push("--add-dir", extra.addDir);
  if (extra.attachment) args.push("--attachment", extra.attachment);
  return args;
}

function buildAgentArgs(agent, { model, instruction, extra, tools }) {
  if (agent === "cursor") {
    const args = ["-p", "--trust", "--mode", "ask", "--output-format", "json", ...modelArgs(model)];
    if (extra.addDir) args.push("--add-dir", extra.addDir);
    args.push(instruction);
    return args;
  }
  if (agent === "copilot") {
    return copilotArgs(model, instruction, extra);
  }
  if (tools === "none") {
    return ["-p", "--output-format", "json", "--max-turns", "1", ...modelArgs(model), instruction];
  }
  return [
    "-p",
    "--output-format",
    "json",
    "--max-turns",
    "12",
    "--allowedTools",
    "Read",
    "--allowedTools",
    "Grep",
    "--allowedTools",
    "Glob",
    ...modelArgs(model),
    instruction,
  ];
}

function agentInstruction(agent, { tools, cursorPromptPath, skills }) {
  const skillBit = skills
    ? " If the CLI or repo exposes review skills (code-review, Bugbot, security-review), use them for analysis. Deliverable is the JSON document, not markdown."
    : "";
  const format = "Reply ONLY with the requested JSON object. No markdown, no fences, no surrounding prose.";
  if (tools === "none") {
    if (agent === "copilot") {
      return `${format} Do not use tools or read the repo. The full prompt is in the attached file.${skillBit}`;
    }
    if (agent === "cursor") {
      return `${format} The full prompt is in: ${cursorPromptPath}. Read it. Do not open other files or use shell.${skillBit}`;
    }
    return `${format} Do not use tools or read files. The full prompt is on stdin.${skillBit}`;
  }
  if (agent === "copilot") {
    return `${format} Do not write files or use shell/url. The full prompt is in the attached file. You may read the repo for callers and tests around the diff.${skillBit}`;
  }
  if (agent === "cursor") {
    return `${format} The full prompt is in: ${cursorPromptPath}. Read it. You may read repo files for context. Do not write files or use shell.${skillBit}`;
  }
  return `${format} You may read the repo with Read/Grep/Glob for context. Do not write files or use Bash. The full prompt is on stdin.${skillBit}`;
}

function runAgentOnce({ agent, repo, prompt, model, signal, timeoutMs = 15 * 60 * 1000, tools = "read", skills = false }) {
  throwIfAborted(signal);
  const statuses = detectAgentBins();
  const spec = statuses[agent] || statuses.claude;
  if (!spec.installed || !spec.bin) {
    throw new Error(`${spec.label} CLI no está instalado (${spec.loginHint})`);
  }

  return cliSemaphore.acquire(signal).then((release) => {
    let tmpDir = null;
    const extra = {};
    let cursorPromptPath = "";
    if (agent === "copilot" || agent === "cursor") {
      tmpDir = mkdtempSync(join(tmpdir(), "diff-review-"));
      extra.addDir = tmpDir;
      if (agent === "copilot") {
        const promptPath = join(tmpDir, "prompt.txt");
        writeFileSync(promptPath, prompt, "utf8");
        extra.attachment = promptPath;
      } else {
        cursorPromptPath = join(tmpDir, "prompt.md");
        writeFileSync(cursorPromptPath, prompt, "utf8");
      }
    }

    const instruction = agentInstruction(agent, { tools, cursorPromptPath, skills });
    const args = buildAgentArgs(agent, { model, instruction, extra, tools });
    const env = agent === "cursor" ? cursorCliEnv() : subscriptionEnv();

    logReview(spec.label, "spawn", spec.bin, model || "default", "cwd=", repo);
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawnBin(spec.bin, args, {
        cwd: repo,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      guardChildStdio(child);

      let stdout = "";
      let stderr = "";
      let settled = false;
      const cleanup = () => {
        if (!tmpDir) return;
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        tmpDir = null;
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        release();
        cleanup();
        fn(value);
      };

      const onAbort = () => {
        killProcessTree(child);
        finish(reject, cancelledError());
      };

      const timer = setTimeout(() => {
        killProcessTree(child);
        finish(reject, new Error(`Timeout de ${spec.label} (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        logReview(spec.label, "spawn error", err.message);
        finish(reject, signal?.aborted ? cancelledError() : err);
      });
      child.on("close", (code) => {
        if (signal?.aborted) {
          finish(reject, cancelledError());
          return;
        }
        logReview(spec.label, "exit", code, `${Date.now() - started}ms`, "stdout", stdout.length, "stderr", stderr.length);
        if (stderr.trim()) logReview(spec.label, "stderr", stderr.slice(0, 800));
        if (code !== 0 && !stdout.trim()) {
          const detail = stderr.slice(0, 800) || "sin output";
          if (/ripgrep|\brg is not installed\b/i.test(detail)) {
            finish(reject, new Error(
              "Cursor CLI necesita ripgrep (rg). Lo buscamos junto al IDE; si sigue fallando, instalá rg o usá otro agente.",
            ));
            return;
          }
          finish(reject, new Error(`${spec.label} salió ${code}: ${detail}`));
          return;
        }
        try {
          finish(resolve, parseAgentRun(agent, stdout));
        } catch (err) {
          finish(reject, new Error(`${err.message}\nstderr: ${stderr.slice(0, 400)}\nstdout: ${stdout.slice(0, 400)}`));
        }
      });

      if (agent === "claude") {
        feedStdin(child, prompt);
      } else {
        feedStdin(child, "");
      }
    });
  });
}

async function runAgentWithRetry(opts, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    throwIfAborted(opts.signal);
    try {
      return await runAgentOnce(opts);
    } catch (err) {
      last = err;
      if (isCancelled(err)) throw err;
      if (!isConfigLockError(err) || i === attempts - 1) {
        if (isConfigLockError(err)) {
          throw new Error(
            `${opts.agent === "cursor" ? "Cursor" : agentLabel(opts.agent)} no pudo escribir cli-config.json (el IDE o el antivirus lo tienen abierto). Reintentá; si sigue, usá otro agente.`,
          );
        }
        throw err;
      }
      logReview(opts.agent, "retry", i + 2, "/", attempts, String(err?.message || err).slice(0, 200));
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}

function dump(value) {
  return JSON.stringify(value);
}

function contextBlock(skeleton) {
  const ctx = skeleton.context || {};
  const guidelines = formatGuidelines(ctx.guidelines);
  const rules = guidelines
    || (ctx.rules ? `\nRepo rules (${ctx.rulesFile || "REVIEW.md"}):\n${ctx.rules}\n` : "");
  const allCommits = ctx.commits || [];
  const commits = allCommits.length
    ? `\nCommits (${allCommits.length}):\n${allCommits.map((c) => `- ${c}`).join("\n")}\n`
    : "";
  const testsTouched = ctx.testsTouched || [];
  const tests = testsTouched.length
    ? `\nTests touched (${testsTouched.length}): ${testsTouched.join(", ")}\n`
    : "\nNo test files in this diff.\n";
  const ignored = (ctx.ignored || []).length
    ? `\nIgnored (${skeleton.stats?.filesIgnored ?? ctx.ignored.length}): ${ctx.ignored.slice(0, 15).join(", ")}\n`
    : "";
  return `${commits}${tests}${ignored}${rules}`;
}

function makeAliasMap(slices) {
  const map = new Map();
  const aliasFor = (path) => {
    const key = String(path || "").trim();
    if (!map.has(key)) map.set(key, `a${map.size + 1}`);
    return map.get(key);
  };
  return { aliasFor, map };
}

function pathsTable(slices, aliasFor) {
  return JSON.stringify(
    slices.map(({ file }) => ({ id: aliasFor(file.path), path: file.path })),
    null,
    0,
  );
}

function filesTable(slices, aliasFor) {
  return JSON.stringify(
    slices.map(({ file, diff }) => ({
      id: aliasFor(file.path),
      changeType: file.changeType,
      test: isTestPath(file.path),
      hunks: countHunks([{ diff }]),
      truncated: Boolean(file.truncated || file.modelTruncated),
    })),
    null,
    0,
  );
}

function diffBlocks(slices, aliasFor) {
  return slices.map(({ file, diff }) => `--- ${aliasFor(file.path)}\n${diff}`).join("\n\n");
}

const NOISE_BLOCK = `Do NOT report:
- Pre-existing code or unified-diff context lines (space-prefixed, not +/-).
- Linter/typechecker/formatter/CI noise (style, unused imports, obvious types).
- Naming/style preferences without real consequences.
- Intentional branch behavior.
- Silenced lint rules.
- "Missing docs/coverage" without a concrete broken scenario.

Quality findings must name concrete cost, not vague feelings.`;

function reviewPrompt(skeleton, slices, { note = "", mode = "compact" } = {}) {
  const { aliasFor } = makeAliasMap(slices);
  const scope = note ? `\nSCOPE: ${note}\n` : "";
  const compactNote =
    mode === "compact" || mode === "batched"
      ? "Diffs omit context lines (only @@, +, -). Use paths from the paths table in blocks.file and findings.file.\n"
      : "";
  return `Senior code review. Return ONE JSON object: branch intent, themes (groups), change blocks, findings.

OUTPUT LANGUAGE: Spanish (rioplatense, technical) for all text fields. Do not translate identifiers.
You may read the repo for callers, types, and tests. Do not modify files.
truncated=true → do not invent hidden content or report on it.
${compactNote}${scope}
${NOISE_BLOCK}

1) intent — 2-4 sentences: problem solved and how. No file lists.
2) groups — semantic themes (not per-folder). Order by dependency. title ≤72 chars like type(scope): imperative. 3-8 themes.
3) blocks — one per meaningful change span. lines: post-image @@ range L40-58; deletions use -L88-95. what/why ≤120 chars. Every diff file in blocks or skipped.
4) findings — class=risk (blocking only if should not merge) or class=quality (blocking always false). fix concrete, ≤120 chars.
5) skipped — trivial/generated files with reason.

Branch: ${skeleton.branch} vs ${skeleton.baseBranch}
Stats: ${dump(skeleton.stats)}
${contextBlock(skeleton)}
paths: ${pathsTable(slices, aliasFor)}
files: ${filesTable(slices, aliasFor)}

${diffBlocks(slices, aliasFor)}

---
${jsonContract()}`;
}

function repairPrompt(errors, previous) {
  const prev =
    previous == null ? "" : `\nPrevious response:\n${JSON.stringify(previous).slice(0, 40_000)}\n`;
  return `Fix the JSON review document. OUTPUT LANGUAGE: Spanish for text fields. Do not translate identifiers.

Errors:
- ${errors.join("\n- ")}

${prev}
---
${jsonContract()}

Return ONLY the corrected complete JSON object.`;
}

function synthesisPayloadSummary(merged) {
  const slim = {
    groups: merged.groups || [],
    blocks: (merged.blocks || []).slice(0, 250).map((b) => ({
      id: b.id,
      group: b.group,
      file: b.file,
      what: String(b.what || "").slice(0, 100),
    })),
    findings: (merged.findings || []).slice(0, 80).map((f) => ({
      id: f.id,
      class: f.class,
      file: f.file,
      what: String(f.what || "").slice(0, 100),
    })),
    skipped: merged.skipped || [],
  };
  return JSON.stringify(slim).slice(0, 55_000);
}

function synthesisPrompt(skeleton, merged, batchCount) {
  return `Unified code review synthesis after ${batchCount} parallel partial reviews of the same branch.
Merge fragmented themes into 3-8 semantic themes for the whole branch. Do NOT rewrite blocks/findings/skipped.

OUTPUT LANGUAGE: Spanish for intent and groups.intent.

Branch: ${skeleton.branch} vs ${skeleton.baseBranch}
Stats: ${dump(skeleton.stats)}

Partial review summary:
${synthesisPayloadSummary(merged)}

---
${synthesisContract()}`;
}

function makeProgress(onProgress, total) {
  let current = 0;
  let max = Math.max(1, total);
  return {
    tick(message) {
      current += 1;
      onProgress?.({ phase: "ai", message, current, total: max });
    },
    setTotal(next) {
      max = Math.max(current, next);
    },
  };
}

function stampMs(entry, started) {
  if (entry && entry.ms == null) entry.ms = Math.max(0, Date.now() - started);
}

function pushPrompt(log, { step, label, prompt = "", skipped = false, note = "", responseChars, usage }) {
  log.push({
    step,
    label,
    prompt: String(prompt || ""),
    chars: String(prompt || "").length,
    skipped: Boolean(skipped),
    ...(note ? { note } : {}),
    ...(responseChars != null ? { responseChars: Number(responseChars) || 0 } : {}),
    ...(usage ? { usage } : {}),
  });
}

function stampRunMetrics(entry, run, onMetrics) {
  if (!entry || !run) return;
  entry.responseChars = run.responseChars ?? entry.responseChars;
  if (run.responseText) entry.response = run.responseText;
  if (run.usage) entry.usage = run.usage;
  if (onMetrics && run.usage) {
    onMetrics({
      tokensIn: run.usage.inputTokens,
      tokensOut: run.usage.outputTokens,
      responseChars: run.responseChars,
    });
  } else if (onMetrics && run.responseChars) {
    onMetrics({ responseChars: run.responseChars });
  }
}

/**
 * Un turno de review más, si hace falta, un turno de corrección barato (solo contrato + errores).
 */
async function runAgentValidated({
  agent,
  repo,
  model,
  signal,
  prompt,
  tools,
  skills = false,
  check,
  promptLog,
  step,
  label,
  onLog,
  onMetrics,
}) {
  throwIfAborted(signal);
  const waitId = `wait:${label}`;
  const estTokens = Math.ceil(String(prompt || "").length / 4);
  onLog?.(`Prompt ${label}: ~${String(prompt || "").length.toLocaleString()} chars (~${estTokens} tokens est.)`, {
    promptChars: String(prompt || "").length,
    tokensInEst: estTokens,
    kind: "prompt",
    promptIndex: promptLog.length,
  });
  if (onMetrics) onMetrics({ promptChars: String(prompt || "").length, tokensInEst: estTokens });
  onLog?.(`Esperando respuesta · ${label}…`, { live: true, liveId: waitId, kind: "wait" });
  pushPrompt(promptLog, { step, label, prompt });
  const started = Date.now();
  let result = null;
  let errors = [];
  let lastRun = null;
  try {
    lastRun = await runAgentWithRetry({ agent, repo, model, signal, prompt, tools, skills });
    result = lastRun.payload;
    errors = check(result);
  } catch (err) {
    if (isCancelled(err)) throw err;
    errors = [`no hubo respuesta interpretable: ${String(err?.message || err).slice(0, 200)}`];
  } finally {
    onLog?.("", { freezeLiveId: waitId });
    stampMs(promptLog.at(-1), started);
    stampRunMetrics(promptLog.at(-1), lastRun, onMetrics);
    if (lastRun?.responseChars) {
      onLog?.(`Respuesta ${label}: ${lastRun.responseChars.toLocaleString()} chars`, {
        responseChars: lastRun.responseChars,
      });
    }
  }
  if (!errors.length) return result;

  promptLog.at(-1).note = errors.slice(0, 4).join("; ");
  const repair = repairPrompt(errors, result);
  const repairWaitId = `wait:${label}:repair`;
  onLog?.(`Reparación ${label}: ~${repair.length.toLocaleString()} chars (sin reenviar diffs)`, { kind: "prompt", promptIndex: promptLog.length });
  onLog?.(`Esperando corrección · ${label}…`, { live: true, liveId: repairWaitId, kind: "wait" });
  pushPrompt(promptLog, {
    step: "repair",
    label: `${label} · repair`,
    prompt: repair,
    note: errors.slice(0, 4).join("; "),
  });
  const t2 = Date.now();
  let repaired = null;
  let repairErrors = [];
  let repairRun = null;
  try {
    repairRun = await runAgentWithRetry({
      agent,
      repo,
      model,
      signal,
      prompt: repair,
      tools: "none",
      skills: false,
    });
    repaired = repairRun.payload;
    repairErrors = check(repaired);
  } catch (err) {
    if (isCancelled(err)) throw err;
    repairErrors = [String(err?.message || err).slice(0, 200)];
  } finally {
    onLog?.("", { freezeLiveId: repairWaitId });
    stampMs(promptLog.at(-1), t2);
    stampRunMetrics(promptLog.at(-1), repairRun, onMetrics);
    if (repairRun?.responseChars) {
      onLog?.(`Respuesta repair: ${repairRun.responseChars.toLocaleString()} chars`, {
        responseChars: repairRun.responseChars,
      });
    }
  }
  if (!repairErrors.length) return repaired;

  const best = repaired || result;
  if (!best) throw new Error(`El modelo no devolvió nada usable: ${errors[0]}`);
  promptLog.at(-1).note = `Sigue sin validar: ${repairErrors.slice(0, 3).join("; ")}`;
  return best;
}

/**
 * Presupuesto del turno. Primero con el diff completo; si no entra, se compacta
 * (se tiran las líneas de contexto) y recién si sigue sin entrar se parte en lotes.
 */
const PROMPT_OVERHEAD = 14_000;

function sliceFiles(files, { compact = false } = {}) {
  return files.map((file) => {
    const sliced = modelSlice(file.diff);
    return {
      file: { ...file, modelTruncated: sliced.modelTruncated },
      diff: compact ? compactDiff(sliced.diff) : sliced.diff,
    };
  });
}

function slicesChars(slices) {
  return slices.reduce((total, { file, diff }) => total + diff.length + file.path.length + 40, 0);
}

function batchSlices(slices, { maxFiles = PROMPT_BATCH_FILES, maxChars = PROMPT_BATCH_CHARS } = {}) {
  const budget = maxChars - PROMPT_OVERHEAD;
  const batches = [];
  let current = [];
  let chars = 0;
  for (const slice of slices) {
    const size = slice.diff.length + 200;
    if (current.length && (current.length + 1 > maxFiles || chars + size > budget)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(slice);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Cómo mandar el diff: compactado por defecto; si no entra, en lotes. */
function planReviewTurns(files, { maxChars = PROMPT_BATCH_CHARS } = {}) {
  const budget = maxChars - PROMPT_OVERHEAD;
  const compact = sliceFiles(files, { compact: true });
  if (slicesChars(compact) <= budget) {
    return {
      mode: "compact",
      batches: [compact],
      note: "Context lines were omitted from diffs (only @@, +, -).",
    };
  }

  const batches = batchSlices(compact);
  return {
    mode: "batched",
    batches,
    note: `Diff did not fit in one turn: reviewed in ${batches.length} batches; themes may be fragmented.`,
  };
}

function batchNote(index, total) {
  return total > 1
    ? `este es el lote ${index + 1} de ${total}; agrupá solo lo que ves acá y usá ids con el prefijo ${index + 1}, ej. g${index + 1}1 / b${index + 1}1.`
    : "";
}

/** Los prompts que se van a mandar, sin mandarlos. Alimenta el `--dry-run` del CLI. */
export function buildReviewPrompts(skeleton) {
  const files = flattenFiles(skeleton);
  const plan = planReviewTurns(files);
  return {
    mode: plan.mode,
    note: plan.note,
    prompts: plan.batches.map((batch, i) => ({
      label: plan.batches.length > 1 ? `Review · batch ${i + 1}/${plan.batches.length}` : "Review",
      prompt: reviewPrompt(skeleton, batch, {
        note: batchNote(i, plan.batches.length),
        mode: plan.mode,
      }),
    })),
  };
}

function resolveRequestedModel(agent, requested, configModel) {
  const ui = String(requested || "").trim();
  if (ui && ui !== "default") return ui;
  const cfg = String(configModel || "").trim();
  if (!cfg) return null;
  if (agent === "claude") return cfg;
  if (CLAUDE_ALIASES.has(cfg)) return null;
  return cfg;
}

/**
 * Un turno para toda la review. Ver el branch entero de una es lo que permite
 * armar temas coherentes y ver hallazgos que cruzan archivos; con
 * lotes eso se pierde, y por eso el fallback queda anotado en el reporte.
 */
export async function completeSkeleton({
  agent,
  repo,
  skeleton,
  model,
  signal,
  onProgress,
  onLog,
  onMetrics,
  resume,
  onBatchComplete,
}) {
  const config = loadReviewConfig(repo);
  const resolvedModel = resolveRequestedModel(agent, model, config.model);
  const files = flattenFiles(skeleton);
  const plan = planReviewTurns(files);
  logReview("plan", plan.mode, `${plan.batches.length} turno(s)`, `${files.length} archivos`);
  onLog?.(`Plan: ${plan.mode}, ${plan.batches.length} turno(s), ${files.length} archivos`);

  const batchCount = plan.batches.length;
  const synthesisTurn = plan.mode === "batched" && batchCount > 1;
  const progress = makeProgress(onProgress, batchCount + (synthesisTurn ? 1 : 0));
  const notes = resume?.notes?.length ? [...resume.notes] : plan.note ? [plan.note] : [];
  const useReadTools = plan.mode === "batched" || batchCount > 1;

  const completedMap = new Map();
  if (Array.isArray(resume?.completedBatches)) {
    for (const item of resume.completedBatches) {
      if (item && Number.isInteger(item.index)) completedMap.set(item.index, item);
    }
  }

  const batchResults = await runPool(batchCount, Math.min(BATCH_CONCURRENCY, batchCount), async (i) => {
    throwIfAborted(signal);
    const cached = completedMap.get(i);
    if (cached?.payload) {
      const many = batchCount > 1;
      progress.tick(
        many
          ? `${agentLabel(agent)}: batch ${i + 1}/${batchCount} (retomado)`
          : `${agentLabel(agent)}: reviewing branch (retomado)`,
      );
      onLog?.(
        many
          ? `[${i + 1}/${batchCount}] Lote ${i + 1} retomado desde checkpoint`
          : "Review retomada desde checkpoint",
      );
      return { index: i, payload: cached.payload, localPrompts: cached.prompts || [] };
    }

    const batch = plan.batches[i];
    const many = batchCount > 1;
    progress.tick(
      many
        ? `${agentLabel(agent)}: batch ${i + 1}/${batchCount}`
        : `${agentLabel(agent)}: reviewing branch`,
    );
    const batchPaths = batch.map(({ file }) => file.path);
    const prompt = reviewPrompt(skeleton, batch, {
      note: batchNote(i, batchCount),
      mode: plan.mode,
    });
    const localPrompts = [];
    const payload = await runAgentValidated({
      agent,
      repo,
      model: resolvedModel,
      signal,
      prompt,
      tools: useReadTools ? "read" : "none",
      skills: useReadTools,
      check: (result) => [
        ...validateAgainst(REVIEW_SCHEMA, result),
        ...reviewIssues(result, batchPaths),
      ].slice(0, 12),
      promptLog: localPrompts,
      step: many ? "batch" : "review",
      label: many ? `Review · batch ${i + 1}/${batchCount}` : "Review",
      onLog: (line, meta) => onLog?.(many ? `[${i + 1}/${batchCount}] ${line}` : line, meta),
      onMetrics,
    });
    if (onBatchComplete) {
      const done = [
        ...Array.from(completedMap.values()).map((c) => ({
          index: c.index,
          payload: c.payload,
          prompts: c.prompts || [],
        })),
        { index: i, payload, prompts: localPrompts },
      ].sort((a, b) => a.index - b.index);
      await onBatchComplete({
        index: i,
        payload,
        prompts: localPrompts,
        completedBatches: done,
        mergedPayload: mergeReviewPayloads(done.map((d) => d.payload)),
        batchCount,
        synthesisTurn,
        planMode: plan.mode,
        planNote: plan.note,
        notes,
      });
    }
    return { index: i, payload, localPrompts };
  });

  const prompts = [];
  for (const { localPrompts } of batchResults.sort((a, b) => a.index - b.index)) {
    prompts.push(...localPrompts);
  }

  const payloads = batchResults.sort((a, b) => a.index - b.index).map((r) => r.payload);
  let merged = payloads.length === 1 ? payloads[0] : mergeReviewPayloads(payloads);

  if (synthesisTurn && resume?.synthesisDone && resume?.mergedPayload) {
    merged = resume.mergedPayload;
  } else if (synthesisTurn && !resume?.synthesisDone) {
    progress.tick(`${agentLabel(agent)}: unificando temas`);
    onLog?.("Síntesis: unificando temas del branch…");
    const synthesisPromptText = synthesisPrompt(skeleton, merged, batchCount);
    const synthesis = await runAgentValidated({
      agent,
      repo,
      model: resolvedModel,
      signal,
      prompt: synthesisPromptText,
      tools: "none",
      skills: false,
      check: (result) => validateAgainst(SYNTHESIS_SCHEMA, result).slice(0, 8),
      promptLog: prompts,
      step: "synthesis",
      label: "Synthesis",
      onLog,
      onMetrics,
    });
    merged = applySynthesis(merged, synthesis);
    notes.push("Themes unified in a synthesis pass after batched review.");
  }

  return buildReview({
    skeleton: {
      ...skeleton,
      files,
      agent,
      model: resolvedModel || "default",
      prompts,
    },
    payload: merged,
    notes,
  });
}

export async function pickFolderNative() {
  if (process.platform === "win32") {
    const scriptPath = fileURLToPath(new URL("./pick-folder.ps1", import.meta.url));
    const { stdout, status } = await new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => {
        out += c.toString("utf8");
      });
      child.stderr.on("data", (c) => {
        err += c.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout: out, stderr: err, status: code ?? 1 }));
    });
    if (status === 2) {
      const err = new Error("CANCELLED");
      err.code = "CANCELLED";
      throw err;
    }
    const path = String(stdout || "").trim();
    if (status !== 0 || !path) {
      throw new Error(`No se pudo abrir el diálogo de carpetas.${status ? ` (código ${status})` : ""}`);
    }
    return path;
  }

  if (process.platform === "darwin") {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        "osascript",
        ["-e", 'POSIX path of (choose folder with prompt "Elegí un repositorio git")'],
        { encoding: "utf8", timeout: 5 * 60 * 1000 },
        (err, out) => {
          if (err) {
            const wrapped = new Error("CANCELLED");
            wrapped.code = "CANCELLED";
            reject(err.code === 1 ? wrapped : err);
            return;
          }
          resolve(out);
        },
      );
    });
    const path = String(stdout || "").trim();
    if (!path) {
      const err = new Error("CANCELLED");
      err.code = "CANCELLED";
      throw err;
    }
    return path;
  }

  if (process.platform === "linux") {
    const candidates = [
      ["zenity", ["--file-selection", "--directory", "--title=Elegí un repositorio git"]],
      ["kdialog", ["--getexistingdirectory", ".", "Elegí un repositorio git"]],
    ];
    for (const [bin, args] of candidates) {
      try {
        const stdout = execFileSync(bin, args, {
          encoding: "utf8",
          timeout: 5 * 60 * 1000,
        });
        const path = String(stdout || "").trim();
        if (path) return path;
      } catch (err) {
        if (err?.status === 1 || err?.code === 1) {
          const cancelled = cancelledError("CANCELLED");
          throw cancelled;
        }
      }
    }
    throw new Error("No hay zenity ni kdialog. Pegá la ruta del repo a mano.");
  }

  throw new Error("En este sistema pegá la ruta del repo a mano.");
}
