/**
 * Estampa en el JSON quién generó la review. La CLI lo sabe mejor que el modelo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decodePayload } from "./json-payload.mjs";

/**
 * @param {string} filePath
 * @param {{ agent?: string, model?: string }} provenance
 * @returns {boolean}
 */
export function stampReviewProvenance(filePath, { agent, model } = {}) {
  const agentName = String(agent || "").trim();
  const modelId = String(model || "").trim();
  if (!agentName && !modelId) return false;

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
  payload.meta = meta;
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return true;
}
