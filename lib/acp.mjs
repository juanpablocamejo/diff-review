/**
 * Sesión con un agente por ACP (Agent Client Protocol): JSON-RPC por stdin/stdout del proceso del agente.
 *
 * A diferencia de `runAgent` (una vuelta headless), el proceso queda vivo: la misma sesión sirve para generar la
 * review y después para las preguntas y los cambios que se le pidan desde la web. Cada pedido de permiso pasa por
 * `decide` (ver `acp-policy.mjs`): no hay nadie mirando una terminal para aprobar.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { spawnCommand } from "./agents.mjs";
import { permissionOutcome } from "./acp-policy.mjs";
import { looksLikeAuthFailure } from "./agent-login.mjs";
import { readModelsCache, writeModelsCache } from "./models-cache.mjs";

/**
 * @typedef {import('./agents.mjs').DetectedAgent} DetectedAgent
 * @typedef {import('@agentclientprotocol/sdk').SessionUpdate} SessionUpdate
 * @typedef {import('@agentclientprotocol/sdk').RequestPermissionRequest} PermissionRequest
 * @typedef {{ allow: boolean, reason: string }} Decision
 * @typedef {{ value: string, name: string }} ModelOption
 * @typedef {{
 *   cwd: string,
 *   model?: string,
 *   resumeSessionId?: string,
 *   decide: (toolCall: PermissionRequest['toolCall']) => Decision,
 *   onUpdate?: (update: SessionUpdate) => void,
 *   onPermission?: (toolCall: PermissionRequest['toolCall'], decision: Decision) => void,
 *   // Si la política niega: pedir confirmación al usuario.
 *   // `true` / `{ allow: true }` = allow_once; `{ allow: true, always: true }` = allow_always (si el agente lo ofrece).
 *   onDeniedPermission?: (
 *     toolCall: PermissionRequest['toolCall'],
 *     decision: Decision,
 *   ) => Promise<boolean | { allow: boolean, always?: boolean }>,
 *   onExit?: (info: { code: number | null, stderr: string }) => void,
 *   timeoutMs?: number,
 * }} AcpSessionOptions
 * @typedef {{
 *   sessionId: string,
 *   resumed: boolean,
 *   models: ModelOption[],
 *   currentModel: string,
 *   modelWarning?: string,
 *   setModel: (model: string) => Promise<{ currentModel: string, warning?: string }>,
 *   prompt: (text: string) => Promise<{ stopReason: string }>,
 *   cancel: () => Promise<void>,
 *   close: () => void,
 *   closed: Promise<void>,
 *   stderrTail: () => string,
 * }} AcpSession
 */

/** Cuántos caracteres de stderr del agente se guardan para explicar un fallo. */
const STDERR_TAIL = 4000;

/** El agente tiene un modo ACP declarado (no todos los agentes lo traen). */
export function supportsAcp(agent) {
  return typeof agent?.def?.acp === "function";
}

/**
 * Opción de modelo (`configOptions` con id/categoría "model") de la respuesta de `session/new` o `session/load`.
 * @param {{ configOptions?: any[] | null }} response
 */
export function modelConfig(response) {
  const option = (response?.configOptions ?? []).find((o) => o?.category === "model" || o?.id === "model");
  if (!option || option.type !== "select") return null;
  const flat = (option.options ?? []).flatMap((o) => (Array.isArray(o?.options) ? o.options : [o]));
  return {
    configId: String(option.id),
    current: String(option.currentValue ?? ""),
    options: flat
      .filter((o, i) => o && typeof o.value === "string" && flat.findIndex((x) => x?.value === o.value) === i)
      .map((o) => ({ value: o.value, name: String(o.name ?? o.value) })),
  };
}

/** Tiempo máximo para initialize + session/new|load (+ set model). */
const ACP_START_TIMEOUT_MS = 90_000;

/**
 * Lanza el agente en modo ACP, negocia y abre (o retoma) una sesión.
 * @param {DetectedAgent} agent
 * @param {AcpSessionOptions} opts
 * @returns {Promise<AcpSession>}
 */
export async function startAcpSession(agent, opts) {
  if (!supportsAcp(agent)) throw new Error(`${agent.def.label} no tiene modo ACP.`);
  const { file, args, env, sessionMeta } = agent.def.acp({ path: agent.path });
  const child = spawnCommand(file, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
  });
  child.stdin?.on("error", () => {});

  const conn = acp
    .client({ name: "diff-review" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const toolCall = ctx.params.toolCall;
      const decision = safeDecide(opts.decide, toolCall);
      if (decision.allow) {
        opts.onPermission?.(toolCall, decision);
        return permissionOutcome(ctx.params.options, true);
      }
      // Política niega: no rechazar al toque — la UI puede permitir una vez / sesión / siempre.
      let allow = false;
      let always = false;
      if (opts.onDeniedPermission) {
        try {
          const answer = await opts.onDeniedPermission(toolCall, decision);
          if (answer && typeof answer === "object") {
            allow = Boolean(answer.allow);
            always = Boolean(answer.always);
          } else {
            allow = Boolean(answer);
          }
        } catch {
          allow = false;
          always = false;
        }
      }
      const final = {
        allow,
        reason: allow ? (always ? "permitido siempre" : "permitido por el usuario") : decision.reason,
      };
      opts.onPermission?.(toolCall, final);
      return permissionOutcome(ctx.params.options, allow, { always });
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      opts.onUpdate?.(ctx.params.update);
    })
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));

  const exited = new Promise((resolve) => {
    child.once("error", (err) => {
      stderr += `\n${err.message}`;
      resolve(null);
    });
    child.once("exit", (code) => resolve(code));
  });
  exited.then((code) => {
    conn.close(new Error(`${agent.def.label} terminó (código ${code ?? "?"}).`));
    opts.onExit?.({ code, stderr });
  });

  const close = () => {
    conn.close();
    if (child.exitCode == null) child.kill();
  };

  const timeoutMs = Math.max(15_000, Number(opts.timeoutMs) || ACP_START_TIMEOUT_MS);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    close();
  }, timeoutMs);

  try {
    const init = await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "diff-review", version: "0" },
    });

    const authMethods = Array.isArray(init.authMethods) ? init.authMethods : [];
    /** Métodos donde el agente maneja el login por `authenticate` (no terminal interactiva). */
    const agentAuthMethods = authMethods.filter((m) => m && (!m.type || m.type === "agent") && m.id);

    /** Si session/new falla por auth, pedimos `authenticate` una vez y reintentamos. */
    const tryAuthenticate = async () => {
      for (const method of agentAuthMethods) {
        try {
          await conn.agent.request(acp.methods.agent.authenticate, { methodId: method.id });
          return true;
        } catch {
          /* siguiente método */
        }
      }
      return false;
    };

    const openNewSession = async () => {
      try {
        return await conn.agent.request(acp.methods.agent.session.new, {
          cwd: opts.cwd,
          mcpServers: [],
          ...(sessionMeta ? { _meta: sessionMeta } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (agentAuthMethods.length && looksLikeAuthFailure(msg) && (await tryAuthenticate())) {
          return await conn.agent.request(acp.methods.agent.session.new, {
            cwd: opts.cwd,
            mcpServers: [],
            ...(sessionMeta ? { _meta: sessionMeta } : {}),
          });
        }
        throw err;
      }
    };

    let sessionId = "";
    let response;
    let resumed = false;
    if (opts.resumeSessionId && init.agentCapabilities?.loadSession) {
      try {
        response = await conn.agent.request(acp.methods.agent.session.load, {
          sessionId: opts.resumeSessionId,
          cwd: opts.cwd,
          mcpServers: [],
          ...(sessionMeta ? { _meta: sessionMeta } : {}),
        });
        sessionId = opts.resumeSessionId;
        resumed = true;
      } catch {
        /* la sesión ya no existe del lado del agente: se abre una nueva */
      }
    }
    if (!resumed) {
      response = await openNewSession();
      sessionId = response.sessionId;
    }

    const models = modelConfig(response);
    let currentModel = models?.current ?? "";

    /**
     * @param {string} model
     * @returns {Promise<{ currentModel: string, warning?: string }>}
     */
    const setModel = async (model) => {
      const wanted = String(model || "").trim();
      if (!wanted || wanted === currentModel) return { currentModel };
      if (!models) {
        return { currentModel, warning: `El agente no deja elegir el modelo por ACP; usa el suyo.` };
      }
      if (!models.options.some((o) => o.value === wanted)) {
        return {
          currentModel,
          warning: `El agente no ofrece el modelo "${wanted}"; sigue con "${currentModel}".`,
        };
      }
      await conn.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: models.configId,
        value: wanted,
      });
      currentModel = wanted;
      return { currentModel };
    };

    let modelWarning;
    const initialWanted = String(opts.model || "").trim();
    if (initialWanted) {
      const applied = await setModel(initialWanted);
      if (applied.warning) modelWarning = applied.warning;
    }

    clearTimeout(timer);
    return {
      sessionId,
      resumed,
      models: models?.options ?? [],
      get currentModel() {
        return currentModel;
      },
      ...(modelWarning ? { modelWarning } : {}),
      setModel,
      prompt: async (text) => {
        const res = await conn.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        return { stopReason: String(res.stopReason) };
      },
      cancel: () => conn.agent.notify(acp.methods.agent.session.cancel, { sessionId }),
      close,
      closed: conn.closed,
      stderrTail: () => stderr,
    };
  } catch (err) {
    clearTimeout(timer);
    close();
    const tail = stderr.trim().split(/\r?\n/).slice(-8).join("\n");
    if (timedOut) {
      const msg = `Timeout (${Math.round(timeoutMs / 1000)}s) al lanzar ${agent.def.label}. ¿Está autenticado el CLI?`;
      throw new Error(tail ? `${msg}\n${tail}` : msg);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(tail ? `${reason}\n${tail}` : reason);
  }
}

/**
 * Modelos ACP con caché en `~/.diff-review/models-cache.json` (TTL 24h).
 * @param {DetectedAgent} agent
 * @param {{ cwd: string, timeoutMs?: number, force?: boolean }} opts
 * @returns {Promise<{ models: ModelOption[], currentModel: string, fromCache: boolean }>}
 */
export async function listAcpModelsCached(agent, opts) {
  const force = Boolean(opts?.force);
  if (!force) {
    const hit = readModelsCache(agent.def.id);
    if (hit) {
      return { models: hit.models, currentModel: hit.currentModel, fromCache: true };
    }
  }
  const result = await listAcpModels(agent, opts);
  if (result.models.length) writeModelsCache(agent.def.id, result);
  return { ...result, fromCache: false };
}

/**
 * Modelos que ofrece el agente por ACP (abre una sesión, lee las opciones y la cierra; no manda ningún prompt).
 * @param {DetectedAgent} agent
 * @param {{ cwd: string, timeoutMs?: number }} opts
 * @returns {Promise<{ models: ModelOption[], currentModel: string }>}
 */
export async function listAcpModels(agent, { cwd, timeoutMs = 45_000 }) {
  const ms = Math.max(5_000, Number(timeoutMs) || 45_000);
  /** @type {AcpSession | null} */
  let session = null;
  const pending = startAcpSession(agent, {
    cwd,
    decide: () => ({ allow: false, reason: "solo se listan modelos" }),
  }).then((s) => {
    session = s;
    return s;
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `Timeout (${Math.round(ms / 1000)}s) al consultar modelos de ${agent.def.label}. Reintentá en unos segundos.`
        )
      );
    }, ms);
  });
  try {
    const opened = await Promise.race([pending, timeout]);
    const out = { models: opened.models, currentModel: opened.currentModel };
    opened.close();
    session = null;
    return out;
  } catch (err) {
    pending.then((s) => s.close()).catch(() => {});
    try {
      session?.close();
    } catch {
      /* ya cerrada */
    }
    throw err;
  }
}

/** Un error en la política no puede colgar al agente esperando respuesta: se rechaza. */
function safeDecide(decide, toolCall) {
  try {
    return decide(toolCall);
  } catch (err) {
    return { allow: false, reason: `error en la política: ${err instanceof Error ? err.message : err}` };
  }
}
