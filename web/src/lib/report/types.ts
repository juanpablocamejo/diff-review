export type GroupKind = 'feat' | 'fix' | 'refactor' | 'perf' | 'test' | 'chore' | 'docs' | 'infra';

export type BlockOp = 'add' | 'mod' | 'del' | 'rename';

export type BlockSide = 'new' | 'old';

export type WhySource = 'code' | 'commit' | 'pr' | 'issue' | 'inferred';

export type FindingClass = 'risk' | 'quality';

export type FindingSeverity = 'high' | 'med' | 'low' | 'nit';

export type FindingKind =
	| 'bug'
	| 'race'
	| 'auth'
	| 'security'
	| 'api-break'
	| 'missing-test'
	| 'perf'
	| 'maintainability'
	| 'docs'
	| 'other';

export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export type SkipReason = 'generated' | 'lockfile' | 'format' | 'vendored' | 'binary' | 'trivial' | 'ignored';

export type ReviewGroup = {
	id: string;
	kind: GroupKind;
	title: string;
	intent: string;
};

export type ReviewBlock = {
	id: string;
	group: string;
	file: string;
	lines: string;
	side: BlockSide;
	start: number;
	end: number;
	op: BlockOp;
	what: string;
	why: string;
	source: WhySource;
};

export type ReviewFinding = {
	id: string;
	class: FindingClass;
	severity: FindingSeverity;
	blocking: boolean;
	kind: FindingKind;
	file: string;
	line: number | null;
	block: string;
	what: string;
	fix: string;
};

export type ReviewSkipped = {
	file: string;
	reason: SkipReason;
};

export type ReviewFile = {
	path: string;
	oldPath?: string;
	changeType: ChangeType;
	diff: string;
	group: string;
};

export type ReviewDocument = {
	intent: string;
	groups: ReviewGroup[];
	blocks: ReviewBlock[];
	findings: ReviewFinding[];
	skipped: ReviewSkipped[];
	files: ReviewFile[];
	notes: string[];
};

/** Rango resaltado en el diff, en la numeración de la pre o de la post imagen. */
export type LineRange = {
	side: BlockSide;
	start: number;
	end: number;
};

export type RepoSource = 'local' | 'url';

export type ReportMeta = {
	source: RepoSource;
	repo: string;
	branch: string;
	base: string;
};

/** Documento completo tal como se guarda en localStorage. */
export type SavedReport = {
	id: string;
	meta: ReportMeta;
	document: ReviewDocument;
	savedAt: string;
};

/** Entrada liviana para la lista "Reportes anteriores". */
export type SavedReportSummary = {
	id: string;
	repo: string;
	branch: string;
	base: string;
	savedAt: string;
	groupCount: number;
	blockerCount: number;
	qualityCount: number;
	intent: string;
};
