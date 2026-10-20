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

/** Triage del hallazgo en el JSON (UI / reopen). Ausente = abierto. */
export type FindingResolutionKind = 'ignored' | 'fix' | 'corrected';

export type FindingResolution = {
	kind: FindingResolutionKind;
	/** Qué se cambió al marcar Corregido (resumen del agente). */
	detail?: string;
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
	/** Decisión de triage persistida; la UI la escribe al marcar Ignorar / Corregir / Corregido. */
	resolution?: FindingResolution;
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
	/** Remote git URL (origin); fallback si la carpeta local no existe en otra máquina. */
	remoteUrl?: string;
	/** ISO-8601; informativo (lo llena el agente). */
	generatedAt?: string;
	/** Nombre del tool/agente; informativo. */
	agent?: string;
	/** Id del modelo; informativo. */
	model?: string;
	/** Sesión ACP que generó la review (solo si la lanzó diff-review): permite seguir conversando con el agente. */
	agentSession?: AgentSessionRef;
	/**
	 * Nombre del JSON en `.diff-review/` (repo local). Con `source: 'local'` el viewer lo relee del disco
	 * en vez de guardar el documento entero en localStorage.
	 */
	outputFilename?: string;
};

export type AgentSessionRef = {
	agentId: string;
	sessionId: string;
	outputFilename: string;
};

/** Reporte abierto en el viewer (documento hidratado en memoria). */
export type SavedReport = {
	id: string;
	meta: ReportMeta;
	document: ReviewDocument;
	savedAt: string;
};

/**
 * Lo que vive en localStorage: meta (+ puntero al JSON en disco). El `document` solo se embebe
 * cuando no hay archivo local (p. ej. drag-and-drop sin repo).
 */
export type StoredReport = {
	id: string;
	meta: ReportMeta;
	savedAt: string;
	document?: ReviewDocument;
};

/** Entrada liviana para la lista "Reportes recientes". */
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
	agent?: string;
	model?: string;
};
