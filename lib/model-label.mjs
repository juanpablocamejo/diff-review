/** Compara nombres de modelo ignorando mayúsculas, espacios y puntuación. */
export function modelSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parece un id técnico (claude-opus-5-5) más que un nombre legible. */
function isSlugLike(s) {
  const t = String(s || "").trim();
  if (!t) return true;
  if (/\s/.test(t)) return false;
  if (/[A-Z]/.test(t) && /[a-z]/.test(t) && !t.includes("-")) return false; // "Sonnet", "Auto"
  return /^[a-z0-9][a-z0-9._|-]*$/i.test(t) && (t.includes("-") || t.includes(".") || t.includes("["));
}

/**
 * claude-opus-5-5 → Claude Opus 5.5; gpt-5.6-sol → GPT-5.6 Sol; gemini-3.8-flash → Gemini 3.8 Flash
 * @param {string} id
 */
export function humanizeModelId(id) {
  const base = String(id || "")
    .trim()
    .replace(/\[.*\]$/, "");
  if (!base) return "";
  const parts = base.split(/[-_]/).filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lower = p.toLowerCase();
    if (lower === "gpt" || lower === "gpt5") {
      out.push(lower === "gpt5" ? "GPT-5" : "GPT");
      continue;
    }
    if (lower === "claude" || lower === "gemini" || lower === "grok" || lower === "composer" || lower === "muse") {
      out.push(lower.charAt(0).toUpperCase() + lower.slice(1));
      continue;
    }
    if (lower === "sonnet" || lower === "opus" || lower === "haiku" || lower === "flash" || lower === "codex") {
      out.push(lower.charAt(0).toUpperCase() + lower.slice(1));
      continue;
    }
    // 5-5 → 5.5 (versión mayor-menor)
    if (/^\d+$/.test(p) && i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) {
      out.push(`${p}.${parts[i + 1]}`);
      i++;
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(p)) {
      out.push(p);
      continue;
    }
    out.push(p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  }
  return out.join(" ");
}

/**
 * context=300k,effort=medium,fast=false → ["300k", "medium"]
 * @param {string} raw
 * @returns {string[]}
 */
export function compactModelMeta(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  /** @type {string[]} */
  const badges = [];
  for (const piece of s.split(",")) {
    const part = piece.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) {
      // bare token: "1m", "1M"
      badges.push(part);
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim();
    if (!val || val === "false" || val === "0") continue;
    if (key === "fast" || key === "thinking") {
      if (val === "true" || val === "1") badges.push(key);
      continue;
    }
    if (key === "context" || key === "ctx") {
      badges.push(val);
      continue;
    }
    if (key === "effort" || key === "reasoning_effort" || key === "reasoning") {
      badges.push(val);
      continue;
    }
    badges.push(val);
  }
  return badges;
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {{ title: string, badges: string[], label: string, hint?: string }}
 */
export function formatModelOption(name, value) {
  const n = String(name ?? "").trim();
  const v = String(value ?? "").trim();
  if (!v && !n) return { title: "", badges: [], label: "" };
  if (/^default(\[\])?$/i.test(v) && n) {
    return { title: n, badges: [], label: n };
  }

  const bracket = /^(.+?)\[(.*)\]$/.exec(v);
  const base = bracket ? bracket[1].trim() : v;
  const metaRaw = bracket ? bracket[2].trim() : "";
  let badges = compactModelMeta(metaRaw);

  let title;
  if (n && !isSlugLike(n)) {
    title = n;
  } else if (n && modelSlug(n) === modelSlug(base)) {
    title = isSlugLike(n) ? humanizeModelId(base || n) : n;
  } else if (n && isSlugLike(n)) {
    title = humanizeModelId(base || n);
  } else if (n) {
    title = n;
  } else {
    title = humanizeModelId(base) || base || v;
  }

  // Si el título ya menciona el contexto (p. ej. "Sonnet (1M context)"), no repetir el badge "1m".
  if (badges.length && /\(\s*\d+\s*m\b/i.test(title)) {
    badges = badges.filter((b) => !/^\d+m$/i.test(b));
  }
  const titleSlug = modelSlug(title);
  if (badges.length && titleSlug.includes(modelSlug(badges.join("")))) {
    /* keep badges anyway for effort/fast */
  }

  const hint = badges.length ? `[ ${badges.join(", ")} ]` : undefined;
  const label = hint ? `${title}  ·  ${hint}` : title;
  return { title, badges, label, ...(hint ? { hint } : {}) };
}

/**
 * Etiqueta compacta (compat / un solo string).
 * @param {string} name
 * @param {string} value
 */
export function modelOptionLabel(name, value) {
  return formatModelOption(name, value).label || String(name || value || "").trim();
}

/**
 * Etiqueta del ítem "usar el default del agente".
 * @param {{ value: string, name: string } | undefined} current
 * @param {string} [configuredOptionLabel]
 */
export function defaultModelOptionLabel(current, configuredOptionLabel) {
  const name = String(current?.name ?? "").trim();
  const value = String(current?.value ?? "").trim();
  const generic =
    !name ||
    value === "default" ||
    value === "auto" ||
    /^default(\b|\s|\()/i.test(name) ||
    /^auto(\b|\s|\()/i.test(name) ||
    /\(recommended\)/i.test(name);

  if (generic) {
    const configured = String(configuredOptionLabel ?? "").trim();
    if (configured && configured !== "Por defecto del agente") return configured;
    return "Por defecto del agente";
  }

  const { title, hint } = formatModelOption(name, value);
  return hint ? `Por defecto · ${title}  ·  ${hint}` : `Por defecto · ${title}`;
}

/**
 * Orden de la lista: default (`""`) y `auto` primero, resto A→Z por label.
 * @template {{ value: string, label?: string, title?: string }} T
 * @param {T[]} options
 * @returns {T[]}
 */
export function sortModelSelectOptions(options) {
  const list = Array.isArray(options) ? [...options] : [];

  /** @param {{ value: string, label?: string, title?: string }} o */
  const isAuto = (o) => {
    const v = String(o.value ?? "").toLowerCase();
    if (v === "auto" || v.startsWith("auto[")) return true;
    const t = String(o.title || o.label || "").trim();
    return /^auto\b/i.test(t);
  };

  const defaults = list.filter((o) => o.value === "");
  const autos = list.filter((o) => o.value !== "" && isAuto(o));
  const middle = list.filter((o) => o.value !== "" && !isAuto(o));

  /** @param {{ label?: string, title?: string, value: string }} a */
  /** @param {{ label?: string, title?: string, value: string }} b */
  const byLabel = (a, b) =>
    String(a.label || a.title || a.value).localeCompare(String(b.label || b.title || b.value), "es", {
      sensitivity: "base",
      numeric: true,
    });

  autos.sort(byLabel);
  middle.sort(byLabel);
  return [...defaults, ...autos, ...middle];
}

/**
 * Misma lista que la UI: default + aliases fijos + modelos ACP.
 * Clack: `label` = título amigable, `hint` = `[ 300k, medium ]`.
 * UI: también `title` + `badges` para chips.
 *
 * @param {{ models: { value: string, name: string }[], currentModel: string }} live
 * @param {{ options: { value: string, label: string, hint?: string }[], initialValue?: string }} fixed
 * @returns {{ options: { value: string, label: string, hint?: string, title?: string, badges?: string[] }[], initialValue: string }}
 */
export function buildAcpModelSelectOptions(live, fixed) {
  const fixedOptions = fixed?.options ?? [];
  const fallback = fixedOptions.filter((m) => m.value !== "");
  const configuredLabel = fixedOptions.find((m) => m.value === "")?.label;
  const current = live.models.find((m) => m.value === live.currentModel);
  const seen = new Set(["", "default"]);
  /** @type {{ value: string, label: string, hint?: string, title?: string, badges?: string[] }[]} */
  const options = [
    {
      value: "",
      label: defaultModelOptionLabel(current, configuredLabel),
      title: defaultModelOptionLabel(current, configuredLabel),
      badges: [],
    },
  ];

  for (const m of fallback) {
    if (seen.has(m.value)) continue;
    seen.add(m.value);
    options.push({
      value: m.value,
      label: m.label,
      title: m.label,
      badges: [],
      ...(m.hint ? { hint: m.hint } : {}),
    });
  }

  for (const m of live.models) {
    if (seen.has(m.value)) continue;
    seen.add(m.value);
    const formatted = formatModelOption(m.name, m.value);
    options.push({
      value: m.value,
      label: formatted.title,
      title: formatted.title,
      badges: formatted.badges,
      ...(formatted.hint ? { hint: formatted.hint } : {}),
    });
  }

  return { options: sortModelSelectOptions(options), initialValue: "" };
}
