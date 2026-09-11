import type { ReviewBlock, ReviewDocument, ReviewFile, ReviewFinding, ReviewGroup, ReviewSkipped } from './types';

function parseLineRange(value: unknown): { side: 'new' | 'old'; start: number; end: number } | null {
	const raw = String(value ?? '').trim();
	const match = /^(-)?L?(\d+)(?:\s*[-–]\s*L?(\d+))?$/i.exec(raw);
	if (!match) return null;
	const start = Number(match[2]);
	const end = match[3] ? Number(match[3]) : start;
	return {
		side: match[1] ? 'old' : 'new',
		start: Math.min(start, end),
		end: Math.max(start, end)
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
	return String(value ?? '').trim();
}

export function hasUsableDiffs(doc: ReviewDocument): boolean {
	return (doc.files ?? []).some((f) => typeof f.diff === 'string' && f.diff.length > 0);
}

function coerceBlock(raw: unknown): ReviewBlock {
	const rec = asRecord(raw);
	const range = parseLineRange(rec.lines);
	const side = rec.side === 'old' || rec.side === 'new' ? rec.side : (range?.side ?? 'new');
	const start = Number(rec.start) || range?.start || 0;
	const end = Number(rec.end) || range?.end || start;
	return {
		id: str(rec.id),
		group: str(rec.group),
		file: str(rec.file),
		lines: str(rec.lines) || (start && end ? `L${start}-${end}` : ''),
		side,
		start,
		end,
		op: rec.op === 'add' || rec.op === 'del' || rec.op === 'rename' ? rec.op : 'mod',
		what: str(rec.what),
		why: str(rec.why),
		source:
			rec.source === 'code' || rec.source === 'commit' || rec.source === 'pr' || rec.source === 'issue'
				? rec.source
				: 'inferred'
	};
}

function coerceFile(raw: unknown): ReviewFile | null {
	const rec = asRecord(raw);
	const path = str(rec.path);
	if (!path) return null;
	const changeType =
		rec.changeType === 'added' || rec.changeType === 'deleted' || rec.changeType === 'renamed'
			? rec.changeType
			: 'modified';
	return {
		path,
		oldPath: rec.oldPath ? str(rec.oldPath) : undefined,
		changeType,
		diff: typeof rec.diff === 'string' ? rec.diff : '',
		group: str(rec.group)
	};
}

/** Rellena defaults para que el viewer no se rompa si el JSON vino incompleto. */
export function coerceDocument(raw: unknown): ReviewDocument {
	const d = asRecord(raw);
	const groups = Array.isArray(d.groups)
		? (d.groups as unknown[]).map((g) => {
				const rec = asRecord(g);
				return {
					id: str(rec.id),
					kind: rec.kind,
					title: str(rec.title),
					intent: str(rec.intent)
				} as ReviewGroup;
			})
		: [];
	const findings = Array.isArray(d.findings)
		? (d.findings as unknown[]).map((f) => {
				const rec = asRecord(f);
				return {
					id: str(rec.id),
					class: rec.class === 'quality' ? 'quality' : 'risk',
					severity:
						rec.severity === 'high' || rec.severity === 'low' || rec.severity === 'nit' ? rec.severity : 'med',
					blocking: rec.blocking === true,
					kind: rec.kind,
					file: str(rec.file),
					line: Number.isFinite(Number(rec.line)) ? Number(rec.line) : null,
					block: str(rec.block),
					what: str(rec.what),
					fix: str(rec.fix)
				} as ReviewFinding;
			})
		: [];
	return {
		intent: str(d.intent),
		groups,
		blocks: Array.isArray(d.blocks) ? (d.blocks as unknown[]).map(coerceBlock) : [],
		findings,
		skipped: Array.isArray(d.skipped) ? (d.skipped as ReviewSkipped[]) : [],
		files: Array.isArray(d.files)
			? (d.files as unknown[]).map(coerceFile).filter((f): f is ReviewFile => f !== null)
			: [],
		notes: Array.isArray(d.notes) ? d.notes.filter((n): n is string => typeof n === 'string') : []
	};
}
