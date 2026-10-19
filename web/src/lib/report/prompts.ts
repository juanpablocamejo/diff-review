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

export function buildPrompt(
	meta: ReportMeta,
	opts?: {
		outputFilename?: string;
		acp?: boolean;
		diffRelPath?: string | null;
		mergeBase?: string;
		branchSha?: string;
		baseSha?: string;
		files?: Array<{ path: string; changeType?: string }>;
		ignored?: string[];
		ignoreGlobs?: string[];
	}
): string {
	return buildPromptCore(meta, {
		...opts,
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

/** Findings with 1-based index (document order) for citing in prompts. */
export type NumberedFinding = {
	id: string;
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
		const ref = /^f\d+$/i.test(String(f.id || '').trim())
			? String(f.id).trim().toLowerCase()
			: `f${f.number || i + 1}`;
		let out = `${ref}. [${label}] ${f.file}${f.line ? ':' + f.line : ''}\nWhat: ${f.what}\nSuggested fix: ${f.fix}`;
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
		const ref = /^f\d+$/i.test(String(f.id || '').trim())
			? String(f.id).trim().toLowerCase()
			: `f${f.number}`;
		return `**${ref} · ${badge}** \`${loc}\`\n\n${f.what}\n\n**Sugerencia:** ${f.fix}`;
	});
	return `### Hallazgos de code review${meta.branch ? ', ' + meta.branch : ''}\n\n${chunks.join('\n\n---\n\n')}\n\n_Generado a partir del review automático. Comentario para ${label}._`;
}
