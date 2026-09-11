#!/usr/bin/env node
// Vuelca el diff de un branch contra su base en un esqueleto JSON con la forma
// de schema.json, sin llamar a ningún modelo. Sirve para ver qué se le va a
// mandar al modelo; para la review completa, run-review.mjs o la UI en web/.
//
// Usage:
//   node extract-diff.mjs --repo C:\path\to\repo \
//     --branch feat/my-feature --base develop --out data/<branchSha>-<baseSha>.json

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBranchDiff, writeSkeleton } from "./lib/extract.mjs";
import { assertGitRepo, reportId } from "./lib/git.mjs";

function parseArgs(argv) {
  const a = { repo: process.cwd(), base: "develop" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--repo") a.repo = argv[++i];
    else if (k === "--branch") a.branch = argv[++i];
    else if (k === "--base") a.base = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.branch) {
  console.log(`Usage: node extract-diff.mjs --branch <branch> [--base develop] [--repo .] [--out data/<branchSha>-<baseSha>.json]`);
  process.exit(args.help ? 0 : 1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = assertGitRepo(args.repo);
const skeleton = extractBranchDiff({ repo, branch: args.branch, base: args.base });
const outPath = args.out || resolve(here, `data/${reportId(skeleton.branchSha, skeleton.baseSha)}.json`);
writeSkeleton(outPath, skeleton);
console.log(
  `Esqueleto en ${resolve(outPath)} — ${skeleton.stats.filesChanged} archivos (${skeleton.stats.filesIgnored || 0} ignorados).`,
);
console.log(`Sigue: node scripts/diff-review/run-review.mjs --branch ${args.branch}   (o la UI en web/).`);
