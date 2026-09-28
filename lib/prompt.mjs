/**
 * Prompt de review para el agente (compartido CLI + UI).
 * Mantener alineado con el contrato de schema.json / validate.mjs.
 */
import {
  makeOutputFilename,
  isOutputFilename,
  OUTPUT_FILENAME_LEGACY,
} from "./output-name.mjs";

export {
  makeOutputFilename,
  isOutputFilename,
  OUTPUT_FILENAME_LEGACY,
};

export const OUTPUT_SCHEMA_BLOCK = `{
  "meta": {
    "source": "local|url",
    "repo": "<absolute path or git URL>",
    "branch": "<branch under review>",
    "base": "develop",
    "remoteUrl": "<origin URL; optional when source=url>",
    "generatedAt": "<ISO-8601 datetime; optional, informational>",
    "agent": "<tool name e.g. Claude Code / Cursor; optional, informational>",
    "model": "<model id e.g. claude-opus-…; optional, informational>"
  },
  "intent": "string",
  "groups": [
    {
      "id": "g1",
      "kind": "feat|fix|refactor|perf|test|chore|docs|infra",
      "title": "string ≤72 chars, imperative, no kind prefix",
      "intent": "string"
    }
  ],
  "blocks": [
    {
      "id": "b1",
      "group": "g1",
      "file": "relative/path.ext",
      "lines": "L40-58",
      "side": "new|old",
      "start": 40,
      "end": 58,
      "op": "add|mod|del|rename",
      "what": "string",
      "why": "string",
      "source": "code|commit|pr|issue|inferred"
    }
  ],
  "findings": [
    {
      "id": "f1",
      "class": "risk|quality",
      "severity": "high|med|low|nit",
      "blocking": false,
      "kind": "bug|race|auth|security|api-break|missing-test|perf|maintainability|docs|other",
      "file": "relative/path.ext",
      "line": 87,
      "block": "b1",
      "what": "string",
      "fix": "string"
    }
  ],
  "skipped": [
    { "file": "relative/path-or-glob", "reason": "generated|lockfile|format|vendored|binary|trivial|ignored" }
  ],
  "notes": ["optional short limitations"]
}`;

const RULES = `- Coverage (hard): every path in the diff MUST appear in "blocks" and/or "skipped". Prefer a skipped glob when many files share one reason.
- Do NOT invent files, hunks, or line ranges that are not in the diff.
- Line anchors: "lines"/"start"/"end"/"line" MUST match the chosen "side" ("new" = post-image / right side of @@; "old" = pre-image, typically deletions). One block per coherent change span — not one per line. Point findings at that block; leave "block" empty only if cross-cutting.
- Do NOT report: pre-existing code outside the diff; linter/formatter noise; naming/style prefs with no real consequence; intentional branch behavior; silenced lint rules; "missing docs/coverage" without a concrete broken scenario.
- Quality findings must name a concrete cost, not a vague feeling.
- Signal over volume: prefer fewer high-signal findings. Order findings by severity (high → nit). Use "nit" sparingly.
- "blocking": true ONLY if the branch should not merge as-is. Use only with class "risk".
- Write human-readable strings (intent, title, what, why, fix, notes) in Spanish. Keep enums/ids/paths/JSON keys exactly as in the schema.`;

function workflowLocal(base, branch) {
  return `Workflow:
1. Resolve the merge-base of \`${base}\` and \`${branch}\`.
2. Run exactly: \`git diff ${base}...${branch}\` (three-dot / merge-base diff). Do not use two-dot unless three-dot is impossible.
3. Read enough surrounding code (types, callers, tests) to judge behavior — not only the hunk lines.
4. Emit the JSON file. Do not modify the repo.
5. Validate it with the command in the output section. If it prints INVALID, follow "How to continue" and re-run until it prints OK.`;
}

/** Comando que el agente debe correr; npx por si el bin no está en PATH. */
export function validateCliCommand(filename) {
  const file = String(filename || "diff-rev_<branchTip>_<baseTip>.json").trim();
  return `npx --yes @jpkme/diff-review validate ${file}`;
}

function workflowUrl(base, branch) {
  return `Workflow:
1. If the repo is not local, clone it (or use whatever access you have). Do not modify it.
2. Resolve the merge-base of \`${base}\` and \`${branch}\`.
3. Run exactly: \`git diff ${base}...${branch}\` (three-dot / merge-base diff). Do not use two-dot unless three-dot is impossible.
4. Read enough surrounding code (types, callers, tests) to judge behavior — not only the hunk lines.
5. Emit the JSON file.
6. Validate it with the command in the output section. If it prints INVALID, follow "How to continue" and re-run until it prints OK.`;
}

/**
 * @param {{ source?: string, repo?: string, branch?: string, base?: string, remoteUrl?: string }} meta
 */
export function outputSchemaBlock(meta) {
  const source = meta.source === "url" ? "url" : "local";
  const repo =
    String(meta.repo || "").trim() || (source === "url" ? "<git URL>" : "<absolute repo path>");
  const branch = String(meta.branch || "").trim() || "<branch under review>";
  const base = String(meta.base || "").trim() || "develop";
  const remoteUrl = String(meta.remoteUrl || "").trim() || (source === "url" ? repo : "");
  const metaLines = [
    `    "source": ${JSON.stringify(source)},`,
    `    "repo": ${JSON.stringify(repo)},`,
    `    "branch": ${JSON.stringify(branch)},`,
    `    "base": ${JSON.stringify(base)},`,
  ];
  if (remoteUrl) metaLines.push(`    "remoteUrl": ${JSON.stringify(remoteUrl)},`);
  metaLines.push(
    `    "generatedAt": "<ISO-8601 datetime>",`,
    `    "agent": "<tool name, e.g. Claude Code / Cursor>",`,
    `    "model": "<model id>"`
  );
  const metaBlock = `"meta": {\n${metaLines.join("\n")}\n  }`;
  return OUTPUT_SCHEMA_BLOCK.replace(/"meta": \{[\s\S]*?\n  \}/, metaBlock);
}

/**
 * @param {{ source?: string, repo?: string, branch?: string, base?: string, remoteUrl?: string }} meta
 * @param {{ outputFilename?: string }} [opts]
 */
export function buildPrompt(meta, opts = {}) {
  const outputFilename = opts.outputFilename || makeOutputFilename();
  const repo =
    String(meta.repo || "").trim() ||
    (meta.source === "url" ? "<git URL>" : "<absolute repo path>");
  const branch = String(meta.branch || "").trim() || "<branch under review>";
  const base = String(meta.base || "").trim() || "develop";
  const workflow = meta.source === "url" ? workflowUrl(base, branch) : workflowLocal(base, branch);

  return `You are a senior code reviewer: strict but fair.

Repo: ${repo}
Branch under review: ${branch}
Base (merge-base): ${base}

${workflow}

Rules:
${RULES}

Write the result to \`${outputFilename}\` at the repo root.
- One JSON object only: first character \`{\`, last character \`}\`.
- No prose before/after, no markdown fences.
- Shape (copy "meta" source/repo/branch/base/remoteUrl as given; fill generatedAt/agent/model):

${outputSchemaBlock(meta)}

Include "meta" with the source/repo/branch/base above (and origin "remoteUrl" when local). Also set informational fields: "generatedAt" (ISO-8601 now), "agent" (tool name), "model" (model id). That lets someone reopen the report elsewhere without re-picking the repo.

Do NOT include diffs or a "files" array — the tool computes them with git when opening the report. Do not invent hunks or paste patches into the JSON.

After writing the file, validate it (npx so it works even if \`diff-review\` is not on PATH):

\`${validateCliCommand(outputFilename)}\`

- Exit 0 and a line starting with \`OK\` means the JSON is acceptable. Then tell me that \`${outputFilename}\` was written.
- Exit 1 prints \`INVALID\`, the problems, and how to continue. Fix the same file and re-run that exact command until it prints OK. Do not stop before OK.`;
}
