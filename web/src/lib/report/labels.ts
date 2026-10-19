import type {
	BlockOp,
	ChangeType,
	FindingKind,
	FindingSeverity,
	GroupKind,
	SkipReason,
	WhySource
} from './types';

export const KIND_LABEL: Record<GroupKind, string> = {
	feat: 'feat',
	fix: 'fix',
	refactor: 'refactor',
	perf: 'perf',
	test: 'test',
	chore: 'chore',
	docs: 'docs',
	infra: 'infra'
};

export const OP_LABEL: Record<BlockOp, string> = {
	add: 'agrega',
	mod: 'modifica',
	del: 'borra',
	rename: 'renombra'
};

export const CHANGE_LABEL: Record<ChangeType, string> = {
	added: 'nuevo',
	modified: 'modificado',
	deleted: 'borrado',
	renamed: 'renombrado'
};

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
	high: 'alta',
	med: 'media',
	low: 'baja',
	nit: 'detalle'
};

export const FINDING_KIND_LABEL: Record<FindingKind, string> = {
	bug: 'bug',
	race: 'race',
	auth: 'auth',
	security: 'seguridad',
	'api-break': 'rompe API',
	'missing-test': 'falta test',
	perf: 'performance',
	maintainability: 'mantenibilidad',
	docs: 'docs',
	other: 'otro'
};

export const SKIP_LABEL: Record<SkipReason, string> = {
	generated: 'generado',
	lockfile: 'lockfile',
	format: 'solo formato',
	vendored: 'vendorizado',
	binary: 'binario',
	trivial: 'trivial',
	ignored: 'ignorado'
};

export const SOURCE_LABEL: Record<WhySource, string> = {
	code: 'del código',
	commit: 'del commit',
	pr: 'del PR',
	issue: 'del issue',
	inferred: 'deducido'
};

export function kindLabel(kind: string) {
	return KIND_LABEL[kind as GroupKind] ?? kind;
}

export function opLabel(op: string) {
	return OP_LABEL[op as BlockOp] ?? op;
}

export function changeLabel(changeType: string) {
	return CHANGE_LABEL[changeType as ChangeType] ?? changeType;
}

export function severityLabel(severity: string) {
	return SEVERITY_LABEL[severity as FindingSeverity] ?? severity;
}

export function findingKindLabel(kind: string) {
	return FINDING_KIND_LABEL[kind as FindingKind] ?? kind;
}

export function skipLabel(reason: string) {
	return SKIP_LABEL[reason as SkipReason] ?? reason;
}

export function sourceLabel(source: string) {
	return SOURCE_LABEL[source as WhySource] ?? source;
}

/** "1 archivo" / "3 archivos". En español, 0 usa plural. */
export function plural(n: number, one: string, many: string) {
	return `${n} ${n === 1 ? one : many}`;
}

/** Solo la palabra flexionada (cuando el número va aparte). */
export function pluralWord(n: number, one: string, many: string) {
	return n === 1 ? one : many;
}

/** Ref visible de un tema: `t1` (ids viejos `g1` se muestran como `t1`). */
export function themeRef(id: string, number = 0): string {
	const raw = String(id || '').trim();
	const m = /^(?:t|g)(\d+)$/i.exec(raw);
	if (m) return `t${m[1]}`;
	if (number > 0) return `t${number}`;
	return raw || 't?';
}

/** Ref visible de un hallazgo: `f1` (no `#1`). */
export function findingRef(id: string, number = 0): string {
	const raw = String(id || '').trim();
	const m = /^f(\d+)$/i.exec(raw);
	if (m) return `f${m[1]}`;
	if (number > 0) return `f${number}`;
	return raw || 'f?';
}

/** Ref visible de un bloque: `b1`. */
export function blockRef(id: string, number = 0): string {
	const raw = String(id || '').trim();
	const m = /^b(\d+)$/i.exec(raw);
	if (m) return `b${m[1]}`;
	if (number > 0) return `b${number}`;
	return raw || 'b?';
}

/** Prefijo de chat para un hallazgo (el usuario completa la pregunta). */
export function askDraftFinding(f: {
	id: string;
	number?: number;
	file: string;
	line: number | null;
}): string {
	const ref = findingRef(f.id, f.number ?? 0);
	const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
	return `Sobre ${ref} (${loc}): `;
}

/** Prefijo de chat para un tema. */
export function askDraftTheme(g: { id: string; number?: number; title: string }): string {
	const ref = themeRef(g.id, g.number ?? 0);
	const title = String(g.title || '').trim();
	return title ? `Sobre el tema ${ref} («${title}»): ` : `Sobre el tema ${ref}: `;
}

/** Prefijo de chat para un bloque de cambios. */
export function askDraftBlock(b: { id: string; file: string; lines: string }): string {
	const ref = blockRef(b.id);
	const lines = String(b.lines || '').trim();
	return lines
		? `Sobre el bloque ${ref} (${b.file} ${lines}): `
		: `Sobre el bloque ${ref} (${b.file}): `;
}

/**
 * El chip ya muestra el kind: saca el prefijo tipo conventional-commit del título
 * (`feat(warehouses): foo` → `warehouses: foo`, `chore: bar` → `bar`).
 */
export function displayGroupTitle(title: string, kind: string): string {
	const raw = String(title ?? '').replace(/\s+/g, ' ').trim();
	const k = String(kind ?? '').trim().toLowerCase();
	if (!raw || !k) return raw;
	const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = raw.match(new RegExp(`^${escaped}(?:\\(([^)]*)\\))?\\s*:\\s*(.*)$`, 'i'));
	if (!match) return raw;
	const scope = (match[1] ?? '').trim();
	const rest = (match[2] ?? '').trim();
	if (!rest) return scope || raw;
	return scope ? `${scope}: ${rest}` : rest;
}
