/**
 * Estampa en el JSON quién generó la review. La CLI lo sabe mejor que el modelo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decodePayload } from "./json-payload.mjs";

/**
 * `agentSession` = la sesión ACP que generó la review, para seguir conversando con el agente desde la web.
 * @param {string} filePath
 * `modelLabel` = nombre legible que el agente da al modelo ("Haiku 5.5"): `model` puede ser un alias
 * (`haiku`) que más adelante apunte a otra versión.
 * `generatedAt` = cuándo terminó la review (ISO). Pisa el del agente, que no sabe la hora real
 * (suele poner la medianoche UTC del día).
 * @param {{ agent?: string, model?: string, modelLabel?: string, generatedAt?: string, agentSession?: { agentId: string, sessionId: string, outputFilename: string } }} provenance
 * @returns {boolean}
 */
export function stampReviewProvenance(filePath, { agent, model, modelLabel, generatedAt, agentSession } = {}) {
  const agentName = String(agent || "").trim();
  const modelId = String(model || "").trim();
  const label = String(modelLabel || "").trim();
  const when = String(generatedAt || "").trim();
  if (!agentName && !modelId && !agentSession && !when) return false;

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
  if (modelId) {
    meta.model = modelId;
    // Un label viejo describiría otro modelo: se reemplaza o se borra junto con `model`.
    if (label && label !== modelId) meta.modelLabel = label;
    else delete meta.modelLabel;
  }
  if (when) meta.generatedAt = when;
  if (agentSession) meta.agentSession = { ...agentSession };
  payload.meta = meta;
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return true;
}
