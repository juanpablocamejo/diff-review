/**
 * Prompt de review para el agente (compartido CLI + UI).
 * Mantener alineado con el contrato de schema.json / validate.mjs.
 */
import {
  makeOutputFilename,
  isOutputFilename,
  OUTPUT_DIR,
  OUTPUT_FILENAME_LEGACY,
  outputRelPath,
} from "./output-name.mjs";

export {
  makeOutputFilename,
  isOutputFilename,
  OUTPUT_DIR,
  OUTPUT_FILENAME_LEGACY,
  outputRelPath,
};

export const OUTPUT_SCHEMA_BLOCK = `{
  "meta": {
    "source": "local|url",
    "repo": "<absolute path or git URL>",
    "branch": "<branch under review>",
    "base": "develop",
    "remoteUrl": "<origin URL; optional when source=url>",
    "generatedAt": "<ISO-8601 datetime; optional>",
    "agent": "<required: product name you are, e.g. Claude Code>",
    "model": "<required: exact model id you are running>"
  },
  "intent": "string",
  "groups": [
    {
      "id": "t1",
      "kind": "feat|fix|refactor|perf|test|chore|docs|infra",
      "title": "string, aim for ≤72 chars, imperative, no kind prefix",
      "intent": "string"
    }
  ],
  "blocks": [
    {
      "id": "b1",
      "group": "t1",
      "file": "relative/path.ext",
      "lines": "L40-58",
      "side": "new|old",
      "start": 40,
      "end": 58,
      "op": "add|mod|del|rename",
      "what": "string, aim for ≤120 chars: concrete change + effect",
      "why": "string, aim for ≤120 chars",
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
      "what": "string, aim for ≤120 chars: concrete cause + observable consequence (what fails / risk / cost)",
      "fix": "string, aim for ≤120 chars: suggested change + what the reader gains or avoids if applied"
    }
  ],
  "skipped": [
    { "file": "relative/path-or-glob", "reason": "generated|lockfile|format|vendored|binary|trivial|ignored" }
  ],
  "notes": ["optional short limitations"]
}`;

const RULES = `- Ids: themes use \`t1\`, \`t2\`, …; findings use \`f1\`, \`f2\`, …; blocks use \`b1\`, \`b2\`, …. Reference themes from blocks via \`"group": "t1"\`.
- Coverage (hard): every path in the diff MUST appear in "blocks" and/or "skipped". Prefer a skipped glob when many files share one reason.
- Do NOT invent files, hunks, or line ranges that are not in the diff.
- Line anchors: "lines"/"start"/"end"/"line" MUST match the chosen "side" ("new" = post-image / right side of @@; "old" = pre-image, typically deletions). One block per coherent change span, not one per line. Point findings at that block; leave "block" empty only if cross-cutting.
- Do NOT report: pre-existing code outside the diff; linter/formatter noise; naming/style prefs with no real consequence; intentional branch behavior; silenced lint rules; "missing docs/coverage" without a concrete broken scenario.
- Quality findings must name a concrete cost, not a vague feeling.
- Finding "what": state the concrete cause and the observable consequence (what fails, the risk, or the cost) — not only a symptom.
- Finding "fix": state the suggested change and what the reader gains or avoids if they apply it.
- Signal over volume: prefer fewer high-signal findings. Order findings by severity (high, then nit). Use "nit" sparingly.
- "blocking": true ONLY if the branch should not merge as-is. Use only with class "risk".
- When several read-only lookups are independent (files, searches), batch them in the same turn if your tools allow parallel calls.
- Write human-readable strings (intent, title, what, why, fix, notes) in Spanish. Keep enums/ids/paths/JSON keys exactly as in the schema.
- Length is a soft target, not a check: aim for title ≤72 characters and what/why/fix ≤120 characters. Prefer clarity over shortening. Longer text is still valid. Do not rewrite the file only to shorten it.`;

/** @param {{ hasDiff?: boolean }} [ctx] */
function workflowLocal(base, branch, ctx = {}) {
  if (ctx.hasDiff) {
    return `Workflow:
1. Read the three-dot diff from the path given in "Precomputed git context" below. Do not re-run \`git diff\` unless that file is missing.
2. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
3. Emit the JSON file. Do not modify the repo.
4. Validate it with the command in the output section. If it prints INVALID, follow "How to continue" and re-run until it prints OK.`;
  }
  return `Workflow:
1. Resolve the merge-base of \`${base}\` and \`${branch}\`.
2. Run exactly: \`git diff ${base}...${branch}\` (three-dot / merge-base diff). Do not use two-dot unless three-dot is impossible.
3. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
4. Emit the JSON file. Do not modify the repo.
5. Validate it with the command in the output section. If it prints INVALID, follow "How to continue" and re-run until it prints OK.`;
}

/** Comando que el agente debe correr (sobre `.diff-review/<nombre>`); npx por si el bin no está en PATH. */
export function validateCliCommand(filename) {
  const file = outputRelPath(String(filename || "diff-rev_<branchTip>_<baseTip>.json").trim());
  return `npx --yes @jpkme/diff-review validate ${file}`;
}

/** @param {{ hasDiff?: boolean }} [ctx] */
function workflowUrl(base, branch, ctx = {}) {
  if (ctx.hasDiff) {
    return `Workflow:
1. If the repo is not local, clone it (or use whatever access you have). Do not modify it.
2. Read the three-dot diff from the path given in "Precomputed git context" below. Do not re-run \`git diff\` unless that file is missing.
3. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
4. Emit the JSON file.
5. Validate it with the command in the output section. If it prints INVALID, follow "How to continue" and re-run until it prints OK.`;
  }
  return `Workflow:
1. If the repo is not local, clone it (or use whatever access you have). Do not modify it.
2. Resolve the merge-base of \`${base}\` and \`${branch}\`.
3. Run exactly: \`git diff ${base}...${branch}\` (three-dot / merge-base diff). Do not use two-dot unless three-dot is impossible.
4. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
5. Emit the JSON file.
6. Validate it with the command in the output section. If it prints INVALID, follow "How to continue" and re-run until it prints OK.`;
}

/** Workflow sin paso de validate por CLI (sesiones ACP: valida el server). */
function workflowLocalAcp(ctx = {}) {
  if (ctx.hasDiff) {
    return `Workflow:
1. Read the three-dot diff from the path given in "Precomputed git context" below. Do not re-run \`git diff\` unless that file is missing.
2. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
3. Write the JSON with your file Write/Edit tool (never shell redirection). Do not modify other repo files. The host validates when your turn ends — do not run the validate CLI.`;
  }
  return `Workflow:
1. Resolve the merge-base of the base and branch named above, then run the three-dot \`git diff base...branch\`.
2. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
3. Write the JSON with your file Write/Edit tool (never shell redirection). Do not modify other repo files. The host validates when your turn ends — do not run the validate CLI.`;
}

function workflowUrlAcp(ctx = {}) {
  if (ctx.hasDiff) {
    return `Workflow:
1. If the repo is not local, clone it (or use whatever access you have). Do not modify it.
2. Read the three-dot diff from the path given in "Precomputed git context" below. Do not re-run \`git diff\` unless that file is missing.
3. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
4. Write the JSON with your file Write/Edit tool (never shell redirection). The host validates when your turn ends — do not run the validate CLI.`;
  }
  return `Workflow:
1. If the repo is not local, clone it (or use whatever access you have). Do not modify it.
2. Resolve the merge-base, then run the three-dot \`git diff base...branch\`.
3. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
4. Write the JSON with your file Write/Edit tool (never shell redirection). The host validates when your turn ends — do not run the validate CLI.`;
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
    `    "agent": "<required: product name you are, e.g. Claude Code>",`,
    `    "model": "<required: exact model id you are running>"`
  );
  const metaBlock = `"meta": {\n${metaLines.join("\n")}\n  }`;
  return OUTPUT_SCHEMA_BLOCK.replace(/"meta": \{[\s\S]*?\n  \}/, metaBlock);
}

/**
 * Bloque de contexto git ya resuelto (diff en disco, tips, lista de archivos, ignores).
 * @param {{
 *   diffRelPath?: string | null,
 *   mergeBase?: string,
 *   branchSha?: string,
 *   baseSha?: string,
 *   files?: Array<{ path: string, changeType?: string }>,
 *   ignored?: string[],
 *   ignoreGlobs?: string[],
 * }} ctx
 */
function formatPrecomputedContext(ctx) {
  const lines = ["Precomputed git context (do not rediscover):"];
  if (ctx.mergeBase) lines.push(`- Merge-base SHA: \`${ctx.mergeBase}\``);
  if (ctx.branchSha) lines.push(`- Branch tip SHA: \`${ctx.branchSha}\``);
  if (ctx.baseSha) lines.push(`- Base tip SHA: \`${ctx.baseSha}\``);
  if (ctx.diffRelPath) {
    lines.push(
      `- Diff file (relative to repo root): \`${ctx.diffRelPath}\` — read this file; do not re-run \`git diff\` unless it is missing.`
    );
  }
  const files = Array.isArray(ctx.files) ? ctx.files : [];
  if (files.length) {
    lines.push(`- Files in the diff (${files.length}):`);
    const limit = 200;
    for (const f of files.slice(0, limit)) {
      const path = String(f?.path || "").trim();
      if (!path) continue;
      const kind = String(f?.changeType || "").trim();
      lines.push(kind ? `  - ${kind}: ${path}` : `  - ${path}`);
    }
    if (files.length > limit) lines.push(`  - … and ${files.length - limit} more`);
  }
  const ignored = Array.isArray(ctx.ignored) ? ctx.ignored.filter(Boolean) : [];
  if (ignored.length) {
    lines.push(
      `- Ignored paths (excluded from the file list; if you mention them use "skipped" with reason "ignored"):`
    );
    for (const p of ignored.slice(0, 40)) lines.push(`  - ${p}`);
    if (ignored.length > 40) lines.push(`  - … and ${ignored.length - 40} more`);
  }
  const globs = Array.isArray(ctx.ignoreGlobs) ? ctx.ignoreGlobs.filter(Boolean) : [];
  if (globs.length) {
    lines.push(`- Ignore globs (DEFAULT + config): ${globs.map((g) => `\`${g}\``).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * @param {{ source?: string, repo?: string, branch?: string, base?: string, remoteUrl?: string }} meta
 * @param {{
 *   outputFilename?: string,
 *   acp?: boolean,
 *   diffRelPath?: string | null,
 *   mergeBase?: string,
 *   branchSha?: string,
 *   baseSha?: string,
 *   files?: Array<{ path: string, changeType?: string }>,
 *   ignored?: string[],
 *   ignoreGlobs?: string[],
 * }} [opts]
 */
export function buildPrompt(meta, opts = {}) {
  const outputFilename = opts.outputFilename || makeOutputFilename();
  const outputPath = outputRelPath(outputFilename);
  const repo =
    String(meta.repo || "").trim() ||
    (meta.source === "url" ? "<git URL>" : "<absolute repo path>");
  const branch = String(meta.branch || "").trim() || "<branch under review>";
  const base = String(meta.base || "").trim() || "develop";
  const acp = Boolean(opts.acp);
  const hasDiff = Boolean(String(opts.diffRelPath || "").trim());
  const workflow = acp
    ? meta.source === "url"
      ? workflowUrlAcp({ hasDiff })
      : workflowLocalAcp({ hasDiff })
    : meta.source === "url"
      ? workflowUrl(base, branch, { hasDiff })
      : workflowLocal(base, branch, { hasDiff });

  const precomputed = formatPrecomputedContext({
    diffRelPath: opts.diffRelPath,
    mergeBase: opts.mergeBase,
    branchSha: opts.branchSha,
    baseSha: opts.baseSha,
    files: opts.files,
    ignored: opts.ignored,
    ignoreGlobs: opts.ignoreGlobs,
  });
  const hasPrecomputed =
    hasDiff ||
    opts.mergeBase ||
    opts.branchSha ||
    opts.baseSha ||
    (opts.files && opts.files.length) ||
    (opts.ignored && opts.ignored.length) ||
    (opts.ignoreGlobs && opts.ignoreGlobs.length);

  const validateSection = acp
    ? `When done writing \`${outputPath}\`, stop. The host validates the JSON automatically and will send you any problems — do not run \`npx … validate\` yourself.`
    : `After writing the file, validate it (npx so it works even if \`diff-review\` is not on PATH):

\`${validateCliCommand(outputFilename)}\`

- Exit 0 and a line starting with \`OK\` means the JSON is acceptable. Then tell me that \`${outputPath}\` was written.
- Exit 1 prints \`INVALID\`, the problems, and how to continue. Fix the same file and re-run that exact command until it prints OK. Do not stop before OK.`;

  return `You are a senior code reviewer: strict but fair.

Repo: ${repo}
Branch under review: ${branch}
Base (merge-base): ${base}

${workflow}
${hasPrecomputed ? `\n${precomputed}\n` : ""}
Rules:
${RULES}

Write the result to \`${outputPath}\` (relative to the repo root; use forward slashes, never \`\\\`). The \`${OUTPUT_DIR}/\` folder is already created by the host — do not \`mkdir\` it.
- If that file already exists: **Read it first**, then Edit/overwrite (or Write after Read). Many agents reject Write with "File has not been read yet" unless you Read that exact path first.
- If it does not exist yet: Write is fine. Do NOT use shell redirection (\`>\`, \`>>\`, \`Out-File\`, \`tee\`, etc.) — those are rejected.
- One JSON object only: first character \`{\`, last character \`}\`.
- No prose before/after, no markdown fences.
- Shape (copy "meta" source/repo/branch/base/remoteUrl as given; "agent" and "model" are required):

${outputSchemaBlock(meta)}

Include "meta" with the source/repo/branch/base above (and origin "remoteUrl" when local). "agent" and "model" are required: set "agent" to the product you are (Claude Code, Cursor, Codex, Copilot, Gemini, …) and "model" to the exact model id you are running. Do not leave placeholders or omit them; validation fails without both. "generatedAt" is optional (ISO-8601 now).

Do NOT include diffs or a "files" array. The tool loads the companion \`.diff\` (or computes with git if missing) when opening the report. Do not invent hunks or paste patches into the JSON.

${validateSection}`;
}
