/**
 * Estampa en el JSON quién generó la review. La CLI lo sabe mejor que el modelo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decodePayload } from "./json-payload.mjs";

/**
 * `agentSession` = la sesión ACP que generó la review, para seguir conversando con el agente desde la web.
 * @param {string} filePath
 * @param {{ agent?: string, model?: string, agentSession?: { agentId: string, sessionId: string, outputFilename: string } }} provenance
 * @returns {boolean}
 */
export function stampReviewProvenance(filePath, { agent, model, agentSession } = {}) {
  const agentName = String(agent || "").trim();
  const modelId = String(model || "").trim();
  if (!agentName && !modelId && !agentSession) return false;

  let payload;
  try {
    payload = decodePayload(readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const current = payload.meta;
  const meta =
    current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  if (agentName) meta.agent = agentName;
  if (modelId) meta.model = modelId;
  if (agentSession) meta.agentSession = { ...agentSession };
  payload.meta = meta;
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return true;
}
