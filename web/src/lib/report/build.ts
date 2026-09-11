import { changeLabel, findingKindLabel, kindLabel, opLabel, severityLabel, skipLabel } from './labels';
import type {
	BlockSide,
	ChangeType,
	FindingKind,
	FindingSeverity,
	GroupKind,
	ReviewDocument,
	ReviewFinding
} from './types';

export type FindingCard = {
	id: string;
	number: number;
	what: string;
	fix: string;
	blocking: boolean;
	severity: FindingSeverity;
	kind: FindingKind;
	block: string;
	file: string;
	line: number | null;
	accentColor: string;
	badge: string;
	badgeColor: string;
	kindLabel: string;
	fileLine: string;
};

export type BlockRow = {
	id: string;
	side: BlockSide;
	start: number;
	end: number;
	lines: string;
	opLabel: string;
	what: string;
	why: string;
	accentColor: string;
};

export type FileSection = {
	path: string;
	changeType: ChangeType;
	changeLabel: string;
	diff: string;
	group: string;
	rows: BlockRow[];
	allFindings: FindingCard[];
	blocksForFile: { id: string; side: BlockSide; start: number; end: number }[];
	blockAccent: Record<string, string>;
};

export type GroupSectionModel = {
	id: string;
	kind: GroupKind;
	kindLabel: string;
	kindColor: string;
	title: string;
	intentText: string;
	fileSections: FileSection[];
};

/** Entrada del árbol de archivos del sidebar. */
export type FileNavItem = {
	path: string;
	changeType: ChangeType;
	/** Letra de cambio al estilo git: A, M, D, R. */
	changeMark: string;
	/** Falso para los archivos omitidos: no tienen sección a la que saltar. */
	navigable: boolean;
	skipReasonLabel?: string;
};

export type GroupNavItem = {
	id: string;
	kindLabel: string;
	kindColor: string;
	title: string;
	meta: string;
	/** Hallazgos del tema, para que el sidebar cuente los que ya tienen decisión. */
	findingIds: string[];
};

export type ReportModel = {
	intentText: string;
	notes: string[];
	groupCount: number;
	findingCount: number;
	hasBlockers: boolean;
	blockerBannerText: string;
	groupSections: GroupSectionModel[];
	/** Toda sección de archivo por path, incluidos los archivos que no entraron en ningún tema. */
	fileSectionsByPath: Map<string, FileSection>;
	/** Archivos con hallazgos que ningún bloque explica, así que no caen en ningún tema. */
	looseFileSections: FileSection[];
	/** Todos los archivos del diff, ordenados por path, para el árbol del sidebar. */
	fileNav: FileNavItem[];
	groupsNav: GroupNavItem[];
	/** Todas las findings, ordenadas por bloqueo y severidad — no por orden de aparición. */
	findingsNav: FindingCard[];
	orphanFindings: FindingCard[];
	hasSkipped: boolean;
	skippedList: { path: string; reasonLabel: string }[];
};

const SEV_RANK: Record<FindingSeverity, number> = { high: 0, med: 1, low: 2, nit: 3 };

function severityColor(severity: FindingSeverity) {
	return `var(--sev-${severity})`;
}

function findingAccent(f: Pick<ReviewFinding, 'blocking' | 'severity'>) {
	return f.blocking ? 'var(--danger)' : severityColor(f.severity);
}

function buildFindingCard(f: ReviewFinding, number: number): FindingCard {
	const accentColor = findingAccent(f);
	return {
		id: f.id,
		number,
		what: f.what,
		fix: f.fix,
		blocking: f.blocking,
		severity: f.severity,
		kind: f.kind,
		block: f.block || '',
		file: f.file,
		line: f.line,
		accentColor,
		badgeColor: accentColor,
		badge: f.blocking ? 'BLOQUEA' : severityLabel(f.severity).toUpperCase(),
		kindLabel: findingKindLabel(f.kind),
		fileLine: f.file + (f.line ? ':' + f.line : '')
	};
}

export function buildReportModel(doc: ReviewDocument): ReportModel {
	const groups = doc.groups ?? [];
	const blocks = doc.blocks ?? [];
	const findings = doc.findings ?? [];
	const files = doc.files ?? [];
	const skipped = doc.skipped ?? [];
	const notes = doc.notes ?? [];

	// Numeración estable: el orden original del documento, no el de un nav ordenado por severidad.
	const numberById = new Map<string, number>();
	findings.forEach((f, i) => numberById.set(f.id, i + 1));
	const cardFor = (f: ReviewFinding) => buildFindingCard(f, numberById.get(f.id) ?? 0);

	const filesByPath = new Map(files.map((f) => [f.path, f]));
	const allPaths = new Set(files.map((f) => f.path));
	blocks.forEach((b) => allPaths.add(b.file));

	const groupSections: GroupSectionModel[] = groups.map((g) => {
		const blocksInGroup = blocks.filter((b) => b.group === g.id);
		const pathsInGroup: string[] = [];
		const seen = new Set<string>();
		blocksInGroup.forEach((b) => {
			if (!seen.has(b.file)) {
				seen.add(b.file);
				pathsInGroup.push(b.file);
			}
		});
		files
			.filter((f) => f.group === g.id && !seen.has(f.path))
			.forEach((f) => {
				seen.add(f.path);
				pathsInGroup.push(f.path);
			});

		const fileSections: FileSection[] = pathsInGroup.map((path) => {
			const fmeta = filesByPath.get(path);
			const blocksForFile = blocksInGroup
				.filter((b) => b.file === path)
				.sort((a, b) => (a.start || 0) - (b.start || 0));
			const blockIds = new Set(blocksForFile.map((b) => b.id));

			const allFindings: FindingCard[] = [];
			const blockAccent: Record<string, string> = {};
			const rows: BlockRow[] = blocksForFile.map((b) => {
				const matched = findings.filter((f) => f.file === path && f.block === b.id);
				const hasBlocking = matched.some((f) => f.blocking);
				const topSeverity = matched.slice().sort((a, c) => SEV_RANK[a.severity] - SEV_RANK[c.severity])[0];
				const accentColor = hasBlocking
					? 'var(--danger)'
					: topSeverity
						? severityColor(topSeverity.severity)
						: 'var(--border)';
				if (matched.length) blockAccent[b.id] = accentColor;
				matched.forEach((f) => allFindings.push(cardFor(f)));
				return {
					id: b.id,
					side: b.side,
					start: b.start,
					end: b.end,
					lines: b.lines || (b.start && b.end ? `L${b.start}-${b.end}` : ''),
					opLabel: opLabel(b.op),
					what: b.what,
					why: b.why,
					accentColor
				};
			});

			findings
				.filter((f) => f.file === path && !blockIds.has(f.block))
				.forEach((f) => allFindings.push(cardFor(f)));

			return {
				path,
				changeType: fmeta?.changeType ?? 'modified',
				changeLabel: changeLabel(fmeta?.changeType ?? 'modified'),
				diff: fmeta?.diff ?? '',
				group: g.id,
				rows,
				allFindings,
				blocksForFile: blocksForFile.map((b) => ({ id: b.id, side: b.side, start: b.start, end: b.end })),
				blockAccent
			};
		});

		return {
			id: g.id,
			kind: g.kind,
			kindLabel: kindLabel(g.kind),
			kindColor: `var(--kind-${g.kind})`,
			title: g.title,
			intentText: g.intent,
			fileSections
		};
	});

	const fileSectionsByPath = new Map<string, FileSection>();
	groupSections.forEach((g) =>
		g.fileSections.forEach((fs) => {
			if (!fileSectionsByPath.has(fs.path)) fileSectionsByPath.set(fs.path, fs);
		})
	);
	// Un archivo sin bloques no cae en ningún tema, pero puede tener hallazgos: sin esto,
	// abrir ese hallazgo deja el panel de diff vacío.
	files.forEach((f) => {
		if (fileSectionsByPath.has(f.path)) return;
		fileSectionsByPath.set(f.path, {
			path: f.path,
			changeType: f.changeType,
			changeLabel: changeLabel(f.changeType),
			diff: f.diff ?? '',
			group: f.group ?? '',
			rows: [],
			allFindings: findings.filter((fi) => fi.file === f.path).map(cardFor),
			blocksForFile: [],
			blockAccent: {}
		});
	});

	const groupedPaths = new Set(groupSections.flatMap((g) => g.fileSections.map((fs) => fs.path)));
	const looseFileSections = [...fileSectionsByPath.values()]
		.filter((fs) => !groupedPaths.has(fs.path))
		.sort((a, b) => a.path.localeCompare(b.path));

	const CHANGE_MARK: Record<ChangeType, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
	const skippedByFile = new Map(skipped.map((s) => [s.file, s.reason]));
	const fileNav: FileNavItem[] = [...fileSectionsByPath.values()]
		.map((fs) => ({
			path: fs.path,
			changeType: fs.changeType,
			changeMark: CHANGE_MARK[fs.changeType],
			navigable: true,
			skipReasonLabel: skippedByFile.has(fs.path) ? skipLabel(skippedByFile.get(fs.path)!) : undefined
		}))
		// Los omitidos que el diff ni siquiera trae igual se listan, en gris y sin destino.
		.concat(
			skipped
				.filter((s) => !fileSectionsByPath.has(s.file))
				.map((s) => ({
					path: s.file,
					changeType: 'modified' as ChangeType,
					changeMark: '',
					navigable: false,
					skipReasonLabel: skipLabel(s.reason)
				}))
		)
		.sort((a, b) => a.path.localeCompare(b.path));

	const groupsNav: GroupNavItem[] = groupSections.map((g) => ({
		id: g.id,
		kindLabel: g.kindLabel,
		kindColor: g.kindColor,
		title: g.title,
		meta: `${blocks.filter((b) => b.group === g.id).length} bloques · ${g.fileSections.length} archivos`,
		// Un archivo puede caer en dos temas: sin el Set, su hallazgo se contaría dos veces.
		findingIds: [...new Set(g.fileSections.flatMap((fs) => fs.allFindings.map((f) => f.id)))]
	}));

	const findingsNav = findings
		.slice()
		.sort((a, b) =>
			a.blocking === b.blocking ? SEV_RANK[a.severity] - SEV_RANK[b.severity] : a.blocking ? -1 : 1
		)
		.map(cardFor);

	const orphanFindings = findings.filter((f) => !allPaths.has(f.file)).map(cardFor);

	const blockerCount = findings.filter((f) => f.blocking).length;

	return {
		intentText: doc.intent || 'El agente no dejó una intención general.',
		notes,
		groupCount: groups.length,
		findingCount: findings.length,
		hasBlockers: blockerCount > 0,
		blockerBannerText: `${blockerCount} hallazgo${blockerCount === 1 ? '' : 's'} bloquea${blockerCount === 1 ? '' : 'n'} el merge`,
		groupSections,
		fileSectionsByPath,
		looseFileSections,
		fileNav,
		groupsNav,
		findingsNav,
		orphanFindings,
		hasSkipped: skipped.length > 0,
		skippedList: skipped.map((s) => ({ path: s.file, reasonLabel: skipLabel(s.reason) }))
	};
}
