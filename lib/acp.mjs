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
 *   onExit?: (info: { code: number | null, stderr: string }) => void,
 * }} AcpSessionOptions
 * @typedef {{
 *   sessionId: string,
 *   resumed: boolean,
 *   models: ModelOption[],
 *   currentModel: string,
 *   modelWarning?: string,
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
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const decision = safeDecide(opts.decide, ctx.params.toolCall);
      opts.onPermission?.(ctx.params.toolCall, decision);
      return permissionOutcome(ctx.params.options, decision.allow);
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

  try {
    const init = await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "diff-review", version: "0" },
    });

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
      response = await conn.agent.request(acp.methods.agent.session.new, {
        cwd: opts.cwd,
        mcpServers: [],
        ...(sessionMeta ? { _meta: sessionMeta } : {}),
      });
      sessionId = response.sessionId;
    }

    const models = modelConfig(response);
    let currentModel = models?.current ?? "";
    let modelWarning;
    const wanted = String(opts.model || "").trim();
    if (wanted && models && wanted !== currentModel) {
      if (models.options.some((o) => o.value === wanted)) {
        await conn.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: models.configId, value: wanted });
        currentModel = wanted;
      } else {
        modelWarning = `El agente no ofrece el modelo "${wanted}"; sigue con "${currentModel}".`;
      }
    } else if (wanted && !models) {
      modelWarning = `El agente no deja elegir el modelo por ACP; usa el suyo.`;
    }

    return {
      sessionId,
      resumed,
      models: models?.options ?? [],
      currentModel,
      ...(modelWarning ? { modelWarning } : {}),
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
    close();
    const tail = stderr.trim().split(/\r?\n/).slice(-8).join("\n");
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(tail ? `${reason}\n${tail}` : reason);
  }
}

/**
 * Modelos que ofrece el agente por ACP (abre una sesión, lee las opciones y la cierra; no manda ningún prompt).
 * @param {DetectedAgent} agent
 * @param {{ cwd: string }} opts
 * @returns {Promise<{ models: ModelOption[], currentModel: string }>}
 */
export async function listAcpModels(agent, { cwd }) {
  const session = await startAcpSession(agent, { cwd, decide: () => ({ allow: false, reason: "solo se listan modelos" }) });
  session.close();
  return { models: session.models, currentModel: session.currentModel };
}

/** Un error en la política no puede colgar al agente esperando respuesta: se rechaza. */
function safeDecide(decide, toolCall) {
  try {
    return decide(toolCall);
  } catch (err) {
    return { allow: false, reason: `error en la política: ${err instanceof Error ? err.message : err}` };
  }
}
