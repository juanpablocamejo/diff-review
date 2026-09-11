function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Extrae un objeto JSON del texto del modelo (fences, prosa alrededor, envelope). */
export function decodePayload(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Respuesta vacía.");

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryParseJson(fence[1].trim());
    if (parsed && typeof parsed === "object") return parsed;
  }

  const direct = tryParseJson(raw);
  if (direct && typeof direct === "object") return direct;

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = tryParseJson(raw.slice(start, end + 1));
    if (parsed && typeof parsed === "object") return parsed;
  }

  throw new Error("No se pudo interpretar la respuesta como JSON.");
}
