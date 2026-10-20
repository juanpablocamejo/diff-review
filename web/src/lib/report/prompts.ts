import type { SeqEvent } from './agent-events';
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
import { chatRelPath } from '$review/lib/output-name.mjs';

export { makeOutputFilename, isOutputFilename, OUTPUT_SCHEMA_BLOCK, chatRelPath };
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
		'Do not redo finished work: keep existing "meta", "intent", "groups", "blocks", and "findings" (including any finding `resolution`); only add what is missing.',
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

	const alreadyCorrected = (doc.findings || []).filter((f) => f.resolution?.kind === 'corrected');
	const correctedBlock =
		alreadyCorrected.length > 0
			? `\n\nAlready corrected (do not redo; use as context if related):\n${alreadyCorrected
					.map((f) => {
						const detail = String(f.resolution?.detail || '').trim();
						const loc = f.file + (f.line != null ? `:${f.line}` : '');
						return `- ${f.id} (${loc}): ${f.what}${detail ? `\n  Applied: ${detail}` : ''}`;
					})
					.join('\n')}`
			: '';

	return `You are the same reviewer who produced these findings. Apply ONLY the findings listed below — do not touch any other findings, files, or code outside those fixes. Do NOT rewrite or edit the review JSON. If a fix needs more context, re-read the source file before editing.

Repo: ${meta.repo || '(none)'}
Branch: ${meta.branch || '(none)'}
Base: ${meta.base || 'develop'}

Findings to fix (${selectedFindings.length}):

${chunks.join('\n\n')}${correctedBlock}

When done, reply with a short per-finding detail (Spanish) suitable for \`resolution.detail\`: one or two sentences each on what you changed, keyed by finding id (fN). Do not rewrite the review JSON.`;
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

const HANDOFF_OPEN_LIMIT = 12;
const HANDOFF_CORRECTED_LIMIT = 8;
const HANDOFF_USER_INTENTS = 2;

function truncateOneLine(text: string, max: number): string {
	const one = String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (one.length <= max) return one;
	return `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Transcript legible (turnos user + assistant), sin tools/permisos — mismo criterio que AgentLog muestra como chat.
 * Se escribe en `.diff-review/<stem>.chat.md` al cambiar de agente.
 */
export function formatReadableChatMarkdown(events: SeqEvent[] | undefined): string {
	if (!events?.length) return '';
	const blocks: string[] = [];
	for (const e of events) {
		if (e.type === 'user' && e.mode !== 'review') {
			const body = String(e.text || '').trim();
			if (!body) continue;
			blocks.push(`### User (${e.mode})\n\n${body}`);
		} else if (e.type === 'text' && e.kind === 'message') {
			const body = String(e.text || '').trim();
			if (!body) continue;
			blocks.push(`### Assistant\n\n${body}`);
		}
	}
	if (!blocks.length) return '';
	return ['# Prior agent chat (readable turns only)', '', ...blocks].join('\n\n');
}

/** Últimos 1–2 mensajes de usuario (no review) para el handoff inline. */
function recentUserIntents(events: SeqEvent[] | undefined, limit: number): string[] {
	if (!events?.length || limit <= 0) return [];
	const out: string[] = [];
	for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
		const e = events[i];
		if (e.type === 'user' && e.mode !== 'review') {
			const t = truncateOneLine(e.text, 160);
			if (t) out.push(`(${e.mode}) ${t}`);
		}
	}
	return out.reverse();
}

/**
 * Nota de handoff al cambiar de agente: se antepone al preamble del primer mensaje (`needsContext`).
 * El reporte y el triage se mantienen; el historial largo va a un companion `.chat.md` (path), no inline.
 */
export function buildAgentSwitchHandoff(opts: {
	document: ReviewDocument;
	fromAgentLabel: string;
	toAgentLabel: string;
	transcript?: SeqEvent[];
	/** Path relativo (repo root), p. ej. `.diff-review/<stem>.chat.md`. */
	chatRelPath?: string | null;
}): string {
	const findings = opts.document.findings || [];
	const open = findings.filter((f) => !f.resolution);
	const ignored = findings.filter((f) => f.resolution?.kind === 'ignored');
	const markedFix = findings.filter((f) => f.resolution?.kind === 'fix');
	const corrected = findings.filter((f) => f.resolution?.kind === 'corrected');

	const lines = [
		`Agent handoff: previous agent was ${opts.fromAgentLabel}; you are ${opts.toAgentLabel}. The review JSON and triage are unchanged; only the chat session was reset.`,
		'',
		`Intent: ${String(opts.document.intent || '').trim() || '(none)'}`,
		'',
		`Triage: ${findings.length} findings — ${open.length} open, ${markedFix.length} marked to fix, ${ignored.length} ignored, ${corrected.length} corrected.`
	];

	if (open.length) {
		lines.push('', 'Open findings (short):');
		for (const f of open.slice(0, HANDOFF_OPEN_LIMIT)) {
			const loc = f.file + (f.line != null ? `:${f.line}` : '');
			const badge = f.blocking ? 'BLOCKING' : f.severity;
			lines.push(`- ${f.id} [${badge}] ${loc}: ${truncateOneLine(f.what, 120)}`);
		}
		if (open.length > HANDOFF_OPEN_LIMIT) {
			lines.push(`- … and ${open.length - HANDOFF_OPEN_LIMIT} more`);
		}
	}

	if (markedFix.length) {
		lines.push('', 'Selected for fix:');
		for (const f of markedFix) {
			const loc = f.file + (f.line != null ? `:${f.line}` : '');
			lines.push(`- ${f.id} (${loc}): ${truncateOneLine(f.what, 100)}`);
		}
	}

	if (corrected.length) {
		lines.push('', 'Corrected (with detail):');
		for (const f of corrected.slice(0, HANDOFF_CORRECTED_LIMIT)) {
			const loc = f.file + (f.line != null ? `:${f.line}` : '');
			const detail = truncateOneLine(f.resolution?.detail || '', 140);
			lines.push(
				`- ${f.id} (${loc}): ${truncateOneLine(f.what, 80)}${detail ? `\n  Applied: ${detail}` : ''}`
			);
		}
		if (corrected.length > HANDOFF_CORRECTED_LIMIT) {
			lines.push(`- … and ${corrected.length - HANDOFF_CORRECTED_LIMIT} more`);
		}
	}

	const intents = recentUserIntents(opts.transcript, HANDOFF_USER_INTENTS);
	if (intents.length) {
		lines.push('', 'Recent user intents:');
		for (const t of intents) lines.push(`- ${t}`);
	}

	const chatPath = String(opts.chatRelPath || '').trim();
	if (chatPath) {
		lines.push(
			'',
			`Prior chat transcript (readable turns only): \`${chatPath}\` — read this file only if needed for continuity. Priority remains the triage summary above and the current user message; do not re-litigate the review.`
		);
	}

	return lines.join('\n');
}

/** Path relativo del companion de handoff para un `outputFilename`. */
export function handoffChatRelPath(outputFilename: string): string {
	return chatRelPath(outputFilename);
}

/** Primer mensaje automático tras cambiar de agente si el compositor está vacío. */
export const AGENT_SWITCH_BOOTSTRAP =
	'Acabo de cambiar de agente. Leé el contexto de la review (JSON/diff y la nota de handoff) y confirmame que estás listo; resumí brevemente el estado del triage y los hallazgos abiertos.';

/**
 * Parte el resumen del agente por refs `fN` cuando puede; si no, el mismo texto para todos.
 */
export function splitFixSummary(summary: string, findingIds: string[]): Record<string, string> {
	const trimmed = summary.trim();
	const out: Record<string, string> = {};
	if (!findingIds.length) return out;
	if (!trimmed) {
		for (const id of findingIds) out[id] = '';
		return out;
	}

	const parts = new Map<string, string[]>();
	let current: string | null = null;
	for (const line of trimmed.split(/\r?\n/)) {
		const m = line.match(/^\s*(?:[-*•]|\d+[.)])?\s*\**`?(f\d+)\b`*\**\s*[:.\-–—)]*\s*(.*)$/i);
		if (m) {
			current = m[1].toLowerCase();
			if (!parts.has(current)) parts.set(current, []);
			const rest = (m[2] || '').trim();
			if (rest) parts.get(current)!.push(rest);
			continue;
		}
		if (current) parts.get(current)!.push(line);
	}

	const matched = [...parts.keys()].some((k) =>
		findingIds.some((id) => id.toLowerCase() === k || `f${id}` === k)
	);

	for (const id of findingIds) {
		const key = /^f\d+$/i.test(id) ? id.toLowerCase() : '';
		const chunk = matched && key && parts.has(key) ? parts.get(key)!.join('\n').trim() : '';
		out[id] = chunk || trimmed;
	}
	return out;
}
