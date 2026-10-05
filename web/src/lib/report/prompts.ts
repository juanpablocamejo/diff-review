import { hunkCovers, parseUnifiedDiff } from './diff';
import { severityLabel } from './labels';
import type { FindingSeverity, ReportMeta, ReviewDocument } from './types';
import {
	buildPrompt as buildPromptCore,
	makeOutputFilename,
	isOutputFilename,
	OUTPUT_FILENAME_LEGACY,
	OUTPUT_SCHEMA_BLOCK
} from '$review/lib/prompt.mjs';

export { makeOutputFilename, isOutputFilename, OUTPUT_SCHEMA_BLOCK };
/** Legacy fijo; preferí `makeOutputFilename()` / `outputFilename` de sesión. */
export const OUTPUT_FILENAME = OUTPUT_FILENAME_LEGACY;

const RULES = `- Coverage (hard): every path in the diff MUST appear in "blocks" and/or "skipped". Prefer a skipped glob when many files share one reason.
- Do NOT invent files, hunks, or line ranges that are not in the diff.
- Line anchors: "lines"/"start"/"end"/"line" MUST match the chosen "side" ("new" = post-image / right side of @@; "old" = pre-image, typically deletions). One block per coherent change span, not one per line. Point findings at that block; leave "block" empty only if cross-cutting.
- Do NOT report: pre-existing code outside the diff; linter/formatter noise; naming/style prefs with no real consequence; intentional branch behavior; silenced lint rules; "missing docs/coverage" without a concrete broken scenario.
- Quality findings must name a concrete cost, not a vague feeling.
- Signal over volume: prefer fewer high-signal findings. Order findings by severity (high, then nit). Use "nit" sparingly.
- "blocking": true ONLY if the branch should not merge as-is. Use only with class "risk".
- Write human-readable strings (intent, title, what, why, fix, notes) in Spanish. Keep enums/ids/paths/JSON keys exactly as in the schema.`;

export function buildPrompt(meta: ReportMeta, opts?: { outputFilename?: string }): string {
	return buildPromptCore(meta, {
		outputFilename: opts?.outputFilename || makeOutputFilename()
	});
}

/** How many uncovered paths to list in the coverage prompt before truncating. */
const COVERAGE_LIST_LIMIT = 120;

/**
 * Follow-up when files from the diff are missing from both blocks and skipped.
 * Asks for a full JSON rewrite (UI ingests whole documents, does not merge patches).
 */
export function buildCoveragePromptText(
	meta: ReportMeta,
	missing: string[],
	opts?: { outputFilename?: string }
): string {
	const branch = meta.branch.trim() || '<branch>';
	const base = (meta.base || 'develop').trim();
	const out = opts?.outputFilename || makeOutputFilename();
	const shown = missing.slice(0, COVERAGE_LIST_LIMIT);
	const rest = missing.length - shown.length;
	const list = shown.map((path) => `- ${path}`).join('\n');
	const tail = rest > 0 ? `\n- ... and ${rest} more (all are in the diff)` : '';
	return [
		`The review of \`${branch}\` against \`${base}\` is incomplete: ${missing.length} file(s) from the diff appear in neither "blocks" nor "skipped".`,
		'',
		'Cover these paths:',
		list + tail,
		'',
		'For each: if the change matters, add a "block" (theme, line range, what/why). If it is noise (generated, lockfile, format, vendored, binary, trivial), add it to "skipped" with the reason. Use a skipped glob when many share one reason.',
		'',
		'Do not redo finished work: keep existing "meta", "intent", "groups", "blocks", and "findings"; only add what is missing.',
		'',
		`Human-readable strings in Spanish. Enums/ids/paths unchanged.`,
		'',
		`Rewrite \`${out}\` with the full JSON object (same shape, first char \`{\`, last char \`}\`, no surrounding text).`
	].join('\n');
}

export function buildCommandText(meta: ReportMeta): string {
	const parts: string[] = [];
	if (meta.repo.trim()) parts.push(`repo=${meta.repo.trim()}`);
	if (meta.branch.trim()) parts.push(`branch=${meta.branch.trim()}`);
	parts.push(`base=${(meta.base || 'develop').trim()}`);
	return `/diff-review ${parts.join(' ')}`.trim();
}

export type SkillAgent = 'claude' | 'cursor' | 'copilot';

const SKILL_AGENTS: Record<SkillAgent, { filename: string; argToken: string }> = {
	claude: { filename: 'diff-review.md', argToken: '$ARGUMENTS' },
	cursor: { filename: 'diff-review.md', argToken: '$ARGUMENTS' },
	copilot: { filename: 'diff-review.prompt.md', argToken: '${input:args}' }
};

export function skillFilename(agent: SkillAgent): string {
	return SKILL_AGENTS[agent].filename;
}

export function buildSkillMarkdown(agent: SkillAgent): string {
	const cfg = SKILL_AGENTS[agent];
	const ext = cfg.filename.split('.').pop();
	return `---
description: Produce a code-review JSON report for the diff-review app
---

# /diff-review

Usage: /diff-review repo=<repo> branch=<branch> base=<base>
Arguments: ${cfg.argToken}

You are a senior code reviewer: strict but fair.

Workflow:
1. Resolve the merge-base of \`<base>\` and \`<branch>\`.
2. Run exactly: \`git diff <base>...<branch>\` (three-dot / merge-base diff). Do not use two-dot unless three-dot is impossible.
3. Read enough surrounding code (types, callers, tests) to judge behavior, not only the hunk lines.
4. Emit the JSON file. Do not modify the repo.
5. Validate with \`npx --yes @jpkme/diff-review validate <that-file>\`. If it prints INVALID, follow "How to continue" and re-run until OK.

Rules:
${RULES}

Write the result to \`diff-rev_{branchTip}_{baseTip}.json\` at the repo root (10-char tip SHAs of branch and base).
- One JSON object only: first character \`{\`, last character \`}\`.
- No prose before/after, no markdown fences.
- Shape:

${OUTPUT_SCHEMA_BLOCK}

Include "meta" with source/repo/branch/base from the arguments. If the repo is local, also set "remoteUrl" to origin (so someone else can open the JSON without the same folder).

Do NOT include diffs or a "files" array. The tool computes them with git when opening the report.

When done, say that the JSON file was written.

> This file defines two commands. If your tool needs one file per command, split the section below into a second file "diff-review-fix.${ext}".

# /diff-review-fix

Usage: /diff-review-fix <id1,id2,...> repo=<repo> branch=<branch>
Arguments: ${cfg.argToken}

You will receive a list of findings (file:line, what is wrong, suggested fix, sometimes the block diff). Apply ONLY those fixes. Touch nothing else. If you need more context, re-read the file before editing.

When done, summarize in a list what you changed for each finding.`;
}

export function buildFixCommandText(meta: ReportMeta, ids: string[]): string {
	const parts = [`/diff-review-fix ${ids.join(',')}`];
	if (meta.repo.trim()) parts.push(`repo=${meta.repo.trim()}`);
	if (meta.branch.trim()) parts.push(`branch=${meta.branch.trim()}`);
	return parts.join(' ');
}

/** Findings with 1-based index (document order) for citing in prompts. */
export type NumberedFinding = {
	number: number;
	file: string;
	line: number | null;
	block: string;
	blocking: boolean;
	severity: FindingSeverity;
	what: string;
	fix: string;
};

export function buildFixPromptText(
	selectedFindings: NumberedFinding[],
	doc: ReviewDocument,
	meta: ReportMeta
): string {
	const blocksById = new Map(doc.blocks.map((b) => [b.id, b]));
	const filesByPath = new Map(doc.files.map((f) => [f.path, f]));

	const chunks = selectedFindings.map((f, i) => {
		let diffSnippet = '';
		const block = f.block ? blocksById.get(f.block) : null;
		if (block) {
			const file = filesByPath.get(block.file);
			if (file?.diff) {
				const hunks = parseUnifiedDiff(file.diff);
				const hunk = hunks.find((h) =>
					hunkCovers(h, { side: block.side, start: block.start, end: block.end })
				);
				if (hunk) {
					const body = hunk.lines
						.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
						.join('\n');
					diffSnippet = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.header ? ' ' + hunk.header : ''}\n${body}`;
				}
			}
		}
		const label = f.blocking ? 'BLOQUEANTE' : severityLabel(f.severity).toUpperCase();
		let out = `${i + 1}. [${label}] ${f.file}${f.line ? ':' + f.line : ''}\nWhat: ${f.what}\nSuggested fix: ${f.fix}`;
		if (diffSnippet) out += `\n\n\`\`\`diff\n${diffSnippet}\n\`\`\``;
		return out;
	});

	return `You are the same reviewer who produced these findings. Apply ONLY the fixes listed below. Touch nothing else. If a fix needs more context, re-read the file before editing.

Repo: ${meta.repo || '(none)'}
Branch: ${meta.branch || '(none)'}
Base: ${meta.base || 'develop'}

Findings to fix (${selectedFindings.length}):

${chunks.join('\n\n')}

When done, summarize in a list what you changed for each finding.`;
}

export type PublishPlatform = 'github' | 'gitlab';

export function buildPublishText(
	selectedFindings: NumberedFinding[],
	platform: PublishPlatform,
	meta: ReportMeta
): string {
	const label = platform === 'gitlab' ? 'MR' : 'PR';
	const chunks = selectedFindings.map((f) => {
		const loc = f.file + (f.line ? ':' + f.line : '');
		const badge = f.blocking ? 'BLOQUEANTE' : severityLabel(f.severity).toUpperCase();
		return `**#${f.number} · ${badge}** \`${loc}\`\n\n${f.what}\n\n**Sugerencia:** ${f.fix}`;
	});
	return `### Hallazgos de code review${meta.branch ? ', ' + meta.branch : ''}\n\n${chunks.join('\n\n---\n\n')}\n\n_Generado a partir del review automático. Comentario para ${label}._`;
}
