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

export function plural(n: number, one: string, many: string) {
	return `${n} ${n === 1 ? one : many}`;
}
