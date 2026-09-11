#!/usr/bin/env node
// Corre la review completa de un branch contra su base y guarda el documento
// v2 en data/<branchSha>-<baseSha>.json. Un solo pedido al modelo, salvo que el
// diff no entre en un turno.
//
// Uso:
//   node run-review.mjs --branch feat/mi-feature
//   node run-review.mjs --repo C:\ruta\repo --branch feat/x \
//     --base develop --agent cursor --model default --out data/mi-review.json

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewPrompts, completeSkeleton, isAgentId } from "./lib/agents.mjs";
import { extractBranchDiff, writeSkeleton } from "./lib/extract.mjs";
import { formatDurationMs } from "./lib/format.mjs";
import { assertGitRepo, reportId } from "./lib/git.mjs";

function parseArgs(argv) {
  const a = { repo: process.cwd(), base: "develop", agent: "claude" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--repo") a.repo = argv[++i];
    else if (k === "--branch") a.branch = argv[++i];
    else if (k === "--base") a.base = argv[++i];
    else if (k === "--agent") a.agent = argv[++i];
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.branch) {
  console.log(
    `Uso: node run-review.mjs --branch <branch> [--base develop] [--repo .] [--agent claude|cursor|copilot] [--model <id>] [--out <archivo.json>] [--dry-run]`,
  );
  process.exit(args.help ? 0 : 1);
}

if (!isAgentId(args.agent)) {
  console.error(`Agente desconocido: ${args.agent}. Usá claude, cursor o copilot.`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = assertGitRepo(args.repo);
const startedAt = Date.now();

const extractStarted = Date.now();
const skeleton = extractBranchDiff({ repo, branch: args.branch, base: args.base });
const extractMs = Date.now() - extractStarted;
// Todo lo informativo va a stderr: con --dry-run, stdout es solo el prompt.
console.error(
  `Diff: ${skeleton.stats.filesChanged} archivos, +${skeleton.stats.insertions} −${skeleton.stats.deletions} (${skeleton.stats.filesIgnored || 0} ignorados).`,
);

if (args.dryRun) {
  const { mode, note, prompts } = buildReviewPrompts(skeleton);
  console.error(`Modo: ${mode}, ${prompts.length} turno(s).${note ? ` ${note}` : ""}`);
  for (const { label, prompt } of prompts) {
    console.error(`--- ${label} · ${prompt.length.toLocaleString("es-AR")} chars`);
    console.log(prompt);
  }
  process.exit(0);
}

const aiStarted = Date.now();
const report = await completeSkeleton({
  agent: args.agent,
  repo,
  skeleton,
  model: args.model,
  onProgress: ({ message, current, total }) => console.log(`  [${current}/${total}] ${message}`),
});
const aiMs = Date.now() - aiStarted;

report.repo = repo;
report.agent = args.agent;
report.generatedMs = Date.now() - startedAt;
report.timings = { extractMs, aiMs, renderMs: 0 };

const outPath = args.out || resolve(here, `data/${reportId(skeleton.branchSha, skeleton.baseSha)}.json`);
writeSkeleton(outPath, report);

const blockers = report.findings.filter((f) => f.blocking).length;
const quality = report.findings.filter((f) => f.class === "quality").length;
console.log(
  `Listo en ${formatDurationMs(report.generatedMs)}: ${report.groups.length} temas, ${report.blocks.length} bloques, ${blockers} bloqueante(s), ${quality} de calidad.`,
);
for (const note of report.notes) console.log(`  aviso: ${note}`);
console.log(`Reporte en ${resolve(outPath)}`);
console.log(`Para verlo: bun run --cwd scripts/diff-review/web dev`);

if (blockers > 0) process.exitCode = 2;
