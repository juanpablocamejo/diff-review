export const GROUP_KINDS = ["feat", "fix", "refactor", "perf", "test", "chore", "docs", "infra"];
export const BLOCK_OPS = ["add", "mod", "del", "rename"];
export const WHY_SOURCES = ["code", "commit", "pr", "issue", "inferred"];
export const FINDING_CLASSES = ["risk", "quality"];
export const FINDING_SEVERITIES = ["high", "med", "low", "nit"];
export const FINDING_KINDS = [
  "bug", "race", "auth", "security", "api-break",
  "missing-test", "perf", "maintainability", "docs", "other",
];
export const SKIP_REASONS = ["generated", "lockfile", "format", "vendored", "binary", "trivial", "ignored"];

/** Lo que tiene que devolver el modelo en un turno. El resto lo agrega el pipeline. */
export const REVIEW_SCHEMA = {
  $id: "diff-review",
  type: "object",
  required: ["intent", "groups", "blocks"],
  additionalProperties: true,
  properties: {
    intent: { type: "string", minLength: 40 },
    groups: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "kind", "title", "intent"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { type: "string", enum: GROUP_KINDS },
          title: { type: "string", minLength: 1 },
          intent: { type: "string" },
        },
      },
    },
    blocks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "group", "file", "lines", "op", "what"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          group: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1 },
          lines: { type: "string", minLength: 1 },
          op: { type: "string", enum: BLOCK_OPS },
          what: { type: "string", minLength: 1, maxLength: 120 },
          why: { type: "string", maxLength: 120 },
          source: { type: "string", enum: WHY_SOURCES },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["class", "severity", "kind", "file", "what"],
        additionalProperties: true,
        properties: {
          id: { type: "string" },
          class: { type: "string", enum: FINDING_CLASSES },
          severity: { type: "string", enum: FINDING_SEVERITIES },
          blocking: { type: "boolean" },
          kind: { type: "string", enum: FINDING_KINDS },
          file: { type: "string", minLength: 1 },
          line: { type: ["integer", "null"] },
          block: { type: "string" },
          what: { type: "string", minLength: 1, maxLength: 120 },
          fix: { type: "string", maxLength: 120 },
        },
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "reason"],
        additionalProperties: true,
        properties: {
          file: { type: "string", minLength: 1 },
          reason: { type: "string", enum: SKIP_REASONS },
        },
      },
    },
  },
};

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(expected, actual) {
  const options = Array.isArray(expected) ? expected : [expected];
  if (options.includes(actual)) return true;
  // TOON has no integer/number split; an integer is a valid number.
  return options.includes("number") && actual === "integer";
}

/** Minimal JSON Schema checker (type, required, properties, items, enum, minLength, minItems). */
export function validateAgainst(schema, data, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  const actual = typeOf(data);
  if (schema.type && !typeMatches(schema.type, actual)) {
    errors.push(`${path}: se esperaba ${[].concat(schema.type).join("|")}, llegó ${actual}`);
    return errors;
  }
  if (actual === "string" && schema.minLength && data.length < schema.minLength) {
    errors.push(`${path}: texto demasiado corto (mínimo ${schema.minLength})`);
  }
  if (actual === "string" && schema.maxLength && data.length > schema.maxLength) {
    errors.push(`${path}: texto demasiado largo (máximo ${schema.maxLength})`);
  }
  if (schema.enum && (actual === "string" || actual === "number") && !schema.enum.includes(data)) {
    errors.push(`${path}: valor no permitido (${data}); usá uno de: ${schema.enum.join(", ")}`);
  }
  if (actual === "array") {
    if (schema.minItems && data.length < schema.minItems) {
      errors.push(`${path}: se esperaban al menos ${schema.minItems} ítems`);
    }
    if (schema.items) {
      data.forEach((item, i) => errors.push(...validateAgainst(schema.items, item, `${path}[${i}]`)));
    }
  }
  if (actual === "object") {
    for (const key of schema.required || []) {
      if (data[key] === undefined) errors.push(`${path}: falta ${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (data[key] === undefined) continue;
      errors.push(...validateAgainst(child, data[key], `${path}.${key}`));
    }
  }
  return errors;
}

/**
 * Integridad referencial y cobertura. El schema solo mira formas; esto mira que
 * los ids cierren y que no haya quedado un archivo sin explicar, que es el
 * error que de verdad arruina la review.
 */
export function reviewIssues(payload, knownPaths = []) {
  const errors = [];
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
  const findings = Array.isArray(payload?.findings) ? payload.findings : [];
  const skipped = Array.isArray(payload?.skipped) ? payload.skipped : [];

  const groupIds = new Set(groups.map((g) => g.id));
  const blockIds = new Set(blocks.map((b) => b.id));
  const known = new Set(knownPaths);

  const dupGroups = groups.length - groupIds.size;
  if (dupGroups > 0) errors.push(`hay ${dupGroups} id de tema repetido`);
  const dupBlocks = blocks.length - blockIds.size;
  if (dupBlocks > 0) errors.push(`hay ${dupBlocks} id de bloque repetido`);

  for (const block of blocks) {
    if (!groupIds.has(block.group)) {
      errors.push(`el bloque ${block.id} apunta al tema inexistente ${block.group}`);
    }
    if (known.size && !known.has(block.file)) {
      errors.push(`el bloque ${block.id} apunta a un archivo que no está en el diff: ${block.file}`);
    }
  }

  const usedGroups = new Set(blocks.map((b) => b.group));
  for (const group of groups) {
    if (!usedGroups.has(group.id)) errors.push(`el tema ${group.id} no tiene ningún bloque`);
  }

  for (const finding of findings) {
    if (finding.block && !blockIds.has(finding.block)) {
      errors.push(`el hallazgo ${finding.id || finding.what} apunta al bloque inexistente ${finding.block}`);
    }
    if (known.size && !known.has(finding.file)) {
      errors.push(`el hallazgo ${finding.id || finding.what} apunta a un archivo fuera del diff: ${finding.file}`);
    }
  }

  if (known.size) {
    const covered = new Set([...blocks.map((b) => b.file), ...skipped.map((s) => s.file)]);
    const missing = [...known].filter((path) => !covered.has(path));
    if (missing.length) {
      errors.push(
        `quedaron ${missing.length} archivo(s) sin bloque ni skipped: ${missing.slice(0, 8).join(", ")}`,
      );
    }
  }

  return errors;
}

/** JSON output contract (English instructions; Spanish text fields). */
export function jsonContract() {
  return `OUTPUT: a single JSON object only. No markdown, no fences, no prose before or after.
TEXT LANGUAGE: Spanish (rioplatense, technical) for intent, groups.intent, blocks.what/why, findings.what/fix. Keep code identifiers untranslated.

{
  "intent": "2-4 sentences on what the branch solves",
  "groups": [{ "id": "g1", "kind": "feat", "title": "scope: summary ≤72 chars (do not repeat kind)", "intent": "why this theme exists" }],
  "blocks": [{ "id": "b1", "group": "g1", "file": "exact/path.ts", "lines": "L40-58", "op": "mod", "what": "≤120 chars", "why": "≤120 chars", "source": "code" }],
  "findings": [{ "id": "f1", "class": "risk", "severity": "high", "blocking": true, "kind": "bug", "file": "path.ts", "line": 42, "block": "b1", "what": "≤120 chars", "fix": "≤120 chars" }],
  "skipped": [{ "file": "bun.lock", "reason": "lockfile" }]
}

Enums:
- groups.kind: ${GROUP_KINDS.join(" | ")}
- blocks.op: ${BLOCK_OPS.join(" | ")}
- blocks.source: ${WHY_SOURCES.join(" | ")}
- findings.class: ${FINDING_CLASSES.join(" | ")}
- findings.severity: ${FINDING_SEVERITIES.join(" | ")}
- findings.kind: ${FINDING_KINDS.join(" | ")}
- findings.blocking: boolean
- findings.line: integer or null
- skipped.reason: ${SKIP_REASONS.join(" | ")}`;
}
