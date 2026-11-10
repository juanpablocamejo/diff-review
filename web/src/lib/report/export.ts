import { hunkCovers, lineInRange, parseUnifiedDiff, type DiffLine } from './diff';
import { serializeReviewPayload } from './document';
import {
	displayGroupTitle,
	findingKindLabel,
	findingRef,
	kindLabel,
	plural,
	pluralWord,
	severityLabel,
	themeRef
} from './labels';
import { findingSeverityRank } from './severity';
import type {
	FindingSeverity,
	GroupKind,
	ReviewDocument,
	ReviewFinding,
	SavedReport
} from './types';

export type ExportFormat = 'json' | 'md' | 'html' | 'pdf';
export type ExportMode = 'summary' | 'full';

/** Secciones opcionales al exportar MD/HTML/PDF (JSON siempre es el documento completo). */
export type ExportSection =
	| 'summary'
	| 'intent'
	| 'notes'
	| 'themes'
	| 'findings'
	| 'fixes'
	| 'skipped'
	| 'snippets';

export const EXPORT_SECTION_OPTIONS: { id: ExportSection; label: string; hint: string }[] = [
	{ id: 'summary', label: 'Resumen', hint: 'conteos y severidades' },
	{ id: 'intent', label: 'Intención', hint: 'qué resuelve la rama' },
	{ id: 'notes', label: 'Notas', hint: 'limitaciones del review' },
	{ id: 'themes', label: 'Temas', hint: 'grupos y bloques' },
	{ id: 'findings', label: 'Hallazgos', hint: 'qué pasa / causa' },
	{ id: 'fixes', label: 'Sugerencias de fix', hint: 'cómo corregir' },
	{ id: 'skipped', label: 'Omitidos', hint: 'archivos salteados' },
	{ id: 'snippets', label: 'Snippets de diff', hint: 'recorte por hallazgo' }
];

export const DEFAULT_EXPORT_SECTIONS: ExportSection[] = EXPORT_SECTION_OPTIONS.map((s) => s.id);

export type ExportOptions = {
	/** summary = sin snippets de diff; full = con recortes por hallazgo. Ignorado si hay `sections`. */
	mode?: ExportMode;
	/** Subconjunto de secciones (MD/HTML/PDF). */
	sections?: ExportSection[];
};

function resolveSections(options: ExportOptions): Set<ExportSection> {
	if (options.sections?.length) return new Set(options.sections);
	if (options.mode === 'summary') {
		return new Set<ExportSection>([
			'summary',
			'intent',
			'notes',
			'themes',
			'findings',
			'fixes',
			'skipped'
		]);
	}
	return new Set(DEFAULT_EXPORT_SECTIONS);
}

function hasSection(sections: Set<ExportSection>, id: ExportSection) {
	return sections.has(id);
}

const SEV_COLOR: Record<FindingSeverity | 'blocking', string> = {
	blocking: '#c92a2a',
	high: '#c92a2a',
	med: '#c44d1a',
	low: '#8b7d2e',
	nit: '#6b7280'
};

const KIND_COLOR: Record<GroupKind, string> = {
	feat: '#1f9d55',
	fix: '#c92a2a',
	refactor: '#7c4dd6',
	perf: '#a5720a',
	test: '#2f6fe0',
	chore: '#5b6472',
	docs: '#0f8fa3',
	infra: '#c1690f'
};

const SNIPPET_MAX_LINES = 40;
const SNIPPET_PAD = 3;

function slugBase(report: SavedReport) {
	return (report.meta.branch || 'reporte').replace(/[^a-z0-9.-]+/gi, '-') || 'reporte';
}

function escapeHtml(s: string) {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function triggerDownload(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function fileName(path: string) {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return slash >= 0 ? path.slice(slash + 1) : path;
}

function fileDir(path: string) {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return slash >= 0 ? path.slice(0, slash) : '';
}

function findingBadge(f: ReviewFinding) {
	return f.blocking ? 'BLOQUEANTE' : severityLabel(f.severity).toUpperCase();
}

function findingColor(f: ReviewFinding) {
	return f.blocking ? SEV_COLOR.blocking : SEV_COLOR[f.severity] || SEV_COLOR.nit;
}

function sortedFindings(doc: ReviewDocument): ReviewFinding[] {
	return [...doc.findings].sort((a, b) => findingSeverityRank(a) - findingSeverityRank(b));
}

function severityStats(doc: ReviewDocument) {
	const counts = { blocking: 0, high: 0, med: 0, low: 0, nit: 0 };
	for (const f of doc.findings) {
		if (f.blocking) counts.blocking += 1;
		else counts[f.severity] += 1;
	}
	return counts;
}

function formatSavedAt(iso: string) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString('es-AR', {
		day: '2-digit',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

function linePrefix(l: DiffLine) {
	return (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text;
}

/** Recorte del diff del bloque/línea del hallazgo (no el archivo entero). */
export function findingDiffSnippet(doc: ReviewDocument, finding: ReviewFinding): string | null {
	const block = finding.block ? doc.blocks.find((b) => b.id === finding.block) : undefined;
	const path = block?.file || finding.file;
	const file = doc.files.find((f) => f.path === path);
	if (!file?.diff) return null;

	const hunks = parseUnifiedDiff(file.diff);
	const range =
		block && block.start
			? { side: block.side, start: block.start, end: block.end || block.start }
			: finding.line
				? { side: 'new' as const, start: finding.line, end: finding.line }
				: null;
	if (!range) return null;

	const hunk = hunks.find((h) => hunkCovers(h, range));
	if (!hunk) return null;

	const expanded = {
		side: range.side,
		start: Math.max(1, range.start - SNIPPET_PAD),
		end: range.end + SNIPPET_PAD
	};

	let lines = hunk.lines.filter((l) => {
		if (lineInRange(l, expanded)) return true;
		// Incluir +/- vecinos sin número en el lado del rango.
		if (l.kind === 'del' && range.side === 'new' && l.oldNo != null) {
			return l.oldNo >= expanded.start - 2 && l.oldNo <= expanded.end + 2;
		}
		if (l.kind === 'add' && range.side === 'old' && l.newNo != null) {
			return l.newNo >= expanded.start - 2 && l.newNo <= expanded.end + 2;
		}
		return false;
	});
	if (!lines.length) lines = hunk.lines;
	const truncated = lines.length > SNIPPET_MAX_LINES;
	if (truncated) lines = lines.slice(0, SNIPPET_MAX_LINES);

	const body = lines.map(linePrefix).join('\n');
	const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.header ? ' ' + hunk.header : ''}`;
	return truncated ? `${header}\n${body}\n…` : `${header}\n${body}`;
}

function shortRepo(meta: SavedReport['meta']) {
	const remote = meta.remoteUrl?.trim();
	if (remote) return remote;
	const repo = meta.repo?.trim() || '';
	if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(repo)) return repo;
	return '';
}

/** Título de export: base ← branch (sentido del merge). */
function mergeTitle(meta: SavedReport['meta']) {
	const branch = meta.branch || '—';
	const base = meta.base || 'develop';
	return `${base} ← ${branch}`;
}

/** Markdown legible para compartir o archivar el review. */
export function buildMarkdown(report: SavedReport, options: ExportOptions = {}): string {
	const sections = resolveSections(options);
	const includeFindings = hasSection(sections, 'findings') || hasSection(sections, 'fixes');
	const { meta, document: doc } = report;
	const stats = severityStats(doc);
	const findings = sortedFindings(doc);
	const lines: string[] = [];

	lines.push(`# Review · \`${mergeTitle(meta)}\``);
	lines.push('');
	const provenance = [meta.agent, meta.modelLabel || meta.model].filter(Boolean).join(' · ');
	lines.push(
		`> Generado con **diff-review** · ${formatSavedAt(meta.generatedAt || report.savedAt)}${provenance ? ` · ${provenance}` : ''}`
	);
	if (shortRepo(meta)) lines.push(`> Repo: \`${shortRepo(meta)}\``);
	lines.push('');

	// Índice con links a las secciones. Los visores (GitHub, VS Code) arman el ancla con el
	// título en minúsculas, así que con títulos de una palabra el link es predecible.
	const toc = [
		hasSection(sections, 'summary') && 'Resumen',
		hasSection(sections, 'intent') && 'Intención',
		hasSection(sections, 'notes') && doc.notes?.length && 'Notas',
		hasSection(sections, 'themes') && 'Temas',
		includeFindings && 'Hallazgos',
		hasSection(sections, 'skipped') && doc.skipped?.length && 'Omitidos'
	].filter((s): s is string => typeof s === 'string');
	if (toc.length > 1) {
		lines.push(`**Contenido:** ${toc.map((s) => `[${s}](#${s.toLowerCase()})`).join(' · ')}`);
		lines.push('');
	}

	if (hasSection(sections, 'summary')) {
		lines.push('## Resumen');
		lines.push('');
		lines.push('| | |');
		lines.push('|---|---|');
		lines.push(`| Temas | ${doc.groups.length} |`);
		lines.push(`| Hallazgos | ${doc.findings.length} |`);
		if (stats.blocking) lines.push(`| Bloqueantes | **${stats.blocking}** |`);
		if (stats.high) lines.push(`| Alta | ${stats.high} |`);
		if (stats.med) lines.push(`| Media | ${stats.med} |`);
		if (stats.low) lines.push(`| Baja | ${stats.low} |`);
		if (stats.nit) lines.push(`| Detalle | ${stats.nit} |`);
		lines.push('');
	}

	if (hasSection(sections, 'intent')) {
		lines.push('## Intención');
		lines.push('');
		lines.push(doc.intent?.trim() || '_Sin intención._');
		lines.push('');
	}

	if (hasSection(sections, 'notes') && doc.notes?.length) {
		lines.push('## Notas');
		lines.push('');
		for (const n of doc.notes) lines.push(`- ${n}`);
		lines.push('');
	}

	if (hasSection(sections, 'themes')) {
		lines.push('## Temas');
		lines.push('');
		doc.groups.forEach((g, i) => {
			const title = displayGroupTitle(g.title, g.kind);
			lines.push(`### ${themeRef(g.id, i + 1)} · ${kindLabel(g.kind)} — ${title}`);
			lines.push('');
			if (g.intent?.trim()) {
				lines.push(g.intent.trim());
				lines.push('');
			}
			const blocks = doc.blocks.filter((b) => b.group === g.id);
			for (const b of blocks) {
				const loc = b.lines || (b.start && b.end ? `L${b.start}-${b.end}` : '');
				const name = fileName(b.file);
				lines.push(`- **\`${name}\`**${loc ? ` (${loc})` : ''}: ${b.what}`);
				if (b.why?.trim()) lines.push(`  - _${b.why.trim()}_`);
			}
			if (blocks.length) lines.push('');
		});
	}

	if (includeFindings) {
		lines.push('## Hallazgos');
		lines.push('');
		if (!findings.length) {
			lines.push('_Sin hallazgos._');
			lines.push('');
		} else {
			findings.forEach((f, i) => {
				const badge = findingBadge(f);
				const name = fileName(f.file);
				const dir = fileDir(f.file);
				lines.push(`### ${findingRef(f.id, i + 1)} · ${badge} · ${findingKindLabel(f.kind)}`);
				lines.push('');
				lines.push(`\`${name}${f.line ? ':' + f.line : ''}\`${dir ? ` · \`${dir}\`` : ''} · ${f.class}`);
				lines.push('');
				if (hasSection(sections, 'findings')) {
					if (f.blocking) lines.push('> [!CAUTION]');
					else if (f.severity === 'high') lines.push('> [!WARNING]');
					if (f.blocking || f.severity === 'high') {
						lines.push(`> ${f.what}`);
						lines.push('');
					} else {
						lines.push(f.what);
						lines.push('');
					}
				}
				if (hasSection(sections, 'fixes') && f.fix?.trim()) {
					lines.push(`**Sugerencia:** ${f.fix.trim()}`);
					lines.push('');
				}
				if (hasSection(sections, 'snippets')) {
					const snippet = findingDiffSnippet(doc, f);
					if (snippet) {
						lines.push('```diff');
						lines.push(snippet);
						lines.push('```');
						lines.push('');
					}
				}
			});
		}
	}

	if (hasSection(sections, 'skipped') && doc.skipped?.length) {
		lines.push('## Omitidos');
		lines.push('');
		for (const s of doc.skipped) lines.push(`- \`${s.file}\` (${s.reason})`);
		lines.push('');
	}

	return lines.join('\n');
}

function htmlDiffSnippet(snippet: string): string {
	const rows = snippet.split('\n').map((raw) => {
		if (raw.startsWith('@@')) {
			return `<div class="diff-hunk">${escapeHtml(raw)}</div>`;
		}
		if (raw === '…') {
			return `<div class="diff-more">…</div>`;
		}
		const kind = raw.startsWith('+') ? 'add' : raw.startsWith('-') ? 'del' : 'ctx';
		return `<div class="diff-line ${kind}"><span class="m">${escapeHtml(raw.charAt(0) || ' ')}</span><span class="t">${escapeHtml(raw.slice(1))}</span></div>`;
	});
	return `<pre class="diff">${rows.join('')}</pre>`;
}

/** Id de ancla seguro para el HTML (los ids del documento pueden traer cualquier cosa). */
function anchorId(prefix: string, id: string) {
	return `${prefix}-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export type HtmlBuildOptions = {
	/**
	 * true (descarga .html): sidebar con las secciones, temas y hallazgos plegables.
	 * false (PDF vía print): todo desplegado, sin sidebar ni scripts.
	 */
	interactive?: boolean;
};

/** HTML autocontenido (también base del PDF vía print). */
export function buildHtml(
	report: SavedReport,
	options: ExportOptions = {},
	{ interactive = true }: HtmlBuildOptions = {}
): string {
	const sections = resolveSections(options);
	const includeFindings = hasSection(sections, 'findings') || hasSection(sections, 'fixes');
	const { meta, document: doc } = report;
	const title = `Review · ${mergeTitle(meta)}`;
	const stats = severityStats(doc);
	const findings = sortedFindings(doc);
	const partial =
		options.sections?.length &&
		options.sections.length < DEFAULT_EXPORT_SECTIONS.length &&
		!hasSection(sections, 'snippets');
	// Plegados al abrir el archivo para poder recorrerlo; en el PDF va todo abierto.
	const openAttr = interactive ? '' : ' open';

	const chips = [
		stats.blocking ? `<span class="chip blocking">${plural(stats.blocking, 'bloqueante', 'bloqueantes')}</span>` : '',
		stats.high ? `<span class="chip high">${plural(stats.high, 'alta', 'altas')}</span>` : '',
		stats.med ? `<span class="chip med">${plural(stats.med, 'media', 'medias')}</span>` : '',
		stats.low ? `<span class="chip low">${plural(stats.low, 'baja', 'bajas')}</span>` : '',
		stats.nit ? `<span class="chip nit">${plural(stats.nit, 'detalle', 'detalles')}</span>` : ''
	]
		.filter(Boolean)
		.join('');

	const showThemes = hasSection(sections, 'themes');

	const groupsHtml = showThemes
		? doc.groups
				.map((g, i) => {
					const gTitle = escapeHtml(displayGroupTitle(g.title, g.kind));
					const kind = (g.kind in KIND_COLOR ? g.kind : 'chore') as GroupKind;
					const blocks = doc.blocks.filter((b) => b.group === g.id);
					const blockLis = blocks
						.map((b) => {
							const loc = b.lines || (b.start && b.end ? `L${b.start}-${b.end}` : '');
							const why = b.why?.trim() ? `<div class="why">${escapeHtml(b.why.trim())}</div>` : '';
							const name = fileName(b.file);
							const dir = fileDir(b.file);
							return `<li>
  <div class="file-ref"><strong>${escapeHtml(name)}</strong>${dir ? ` <span class="dir">${escapeHtml(dir)}</span>` : ''}${loc ? ` <span class="loc">${escapeHtml(loc)}</span>` : ''}</div>
  <div>${escapeHtml(b.what)}</div>${why}
</li>`;
						})
						.join('');
					return `<details class="card group" id="${anchorId('t', g.id)}" data-spy${openAttr}>
  <summary>
    <span class="chev" aria-hidden="true"></span>
    <h3 class="sum-h"><span class="num">${escapeHtml(themeRef(g.id, i + 1))}</span> <span class="kind" style="color:${KIND_COLOR[kind]};border-color:${KIND_COLOR[kind]}33">${escapeHtml(kindLabel(g.kind))}</span> <span class="sum-title">${gTitle}</span></h3>
    <span class="sum-count">${plural(blocks.length, 'bloque', 'bloques')}</span>
  </summary>
  <div class="card-body">
    ${g.intent?.trim() ? `<p class="intent">${escapeHtml(g.intent.trim())}</p>` : ''}
    ${blocks.length ? `<ul class="blocks">${blockLis}</ul>` : ''}
  </div>
</details>`;
				})
				.join('\n')
		: '';

	const findingsHtml = !includeFindings
		? ''
		: !findings.length
			? '<p class="empty">Sin hallazgos.</p>'
			: findings
					.map((f, i) => {
						const badge = findingBadge(f);
						const color = findingColor(f);
						const name = fileName(f.file);
						const dir = fileDir(f.file);
						const loc = f.line ? `:${f.line}` : '';
						const snippet = hasSection(sections, 'snippets') ? findingDiffSnippet(doc, f) : null;
						const what = hasSection(sections, 'findings') ? `<p class="what">${escapeHtml(f.what)}</p>` : '';
						const fix =
							hasSection(sections, 'fixes') && f.fix?.trim()
								? `<p class="fix"><strong>Sugerencia</strong> ${escapeHtml(f.fix.trim())}</p>`
								: '';
						// Plegado, el resumen deja ver de qué se trata sin abrirlo.
						const peekText = (hasSection(sections, 'findings') ? f.what : f.fix || f.what)?.trim() || '';
						return `<details class="card finding" id="${anchorId('f', f.id)}" data-spy style="border-left-color:${color}"${openAttr}>
  <summary>
    <span class="chev" aria-hidden="true"></span>
    <h3 class="sum-h"><span class="num">${escapeHtml(findingRef(f.id, i + 1))}</span> <span class="badge" style="color:${color};border-color:${color}55;background:${color}14">${escapeHtml(badge)}</span> <span class="fk">${escapeHtml(findingKindLabel(f.kind))}</span> <span class="sum-file">· ${escapeHtml(name)}${escapeHtml(loc)}</span></h3>
    ${peekText ? `<span class="peek">${escapeHtml(peekText)}</span>` : ''}
  </summary>
  <div class="card-body">
    <div class="meta"><strong>${escapeHtml(name)}${escapeHtml(loc)}</strong>${dir ? ` <span class="dir">${escapeHtml(dir)}</span>` : ''} · ${escapeHtml(f.class)}</div>
    ${what}
    ${fix}
    ${snippet ? htmlDiffSnippet(snippet) : ''}
  </div>
</details>`;
					})
					.join('\n');

	/** Encabezado de sección; con ítems plegables suma "Expandir / Plegar todo". */
	const sectionHead = (label: string, id: string, foldable: boolean) =>
		`<div class="sec-head"><h2>${label}</h2>${
			interactive && foldable
				? `<span class="sec-tools"><button type="button" data-fold="open" data-scope="${id}">Expandir todo</button><button type="button" data-fold="close" data-scope="${id}">Plegar todo</button></span>`
				: ''
		}</div>`;

	const notesHtml =
		hasSection(sections, 'notes') && doc.notes?.length
			? `<section class="section" id="sec-notes" data-spy>${sectionHead('Notas', 'sec-notes', false)}<ul>${doc.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></section>`
			: '';

	const skippedHtml =
		hasSection(sections, 'skipped') && doc.skipped?.length
			? `<section class="section" id="sec-skipped" data-spy>${sectionHead('Omitidos', 'sec-skipped', false)}<ul class="skipped">${doc.skipped.map((s) => `<li><code>${escapeHtml(s.file)}</code> <span class="reason">${escapeHtml(s.reason)}</span></li>`).join('')}</ul></section>`
			: '';

	const repoLine = shortRepo(meta) ? `<div class="repo">${escapeHtml(shortRepo(meta))}</div>` : '';

	const statsHtml = hasSection(sections, 'summary')
		? `<div class="stats">
    <span class="stat"><strong>${doc.groups.length}</strong> ${pluralWord(doc.groups.length, 'tema', 'temas')}</span>
    <span class="stat"><strong>${doc.findings.length}</strong> ${pluralWord(doc.findings.length, 'hallazgo', 'hallazgos')}</span>
    ${chips}
  </div>`
		: '';

	const intentHtml = hasSection(sections, 'intent')
		? `<section class="section" id="sec-intent" data-spy>
    ${sectionHead('Intención', 'sec-intent', false)}
    <p>${escapeHtml(doc.intent?.trim() || 'Sin intención.')}</p>
  </section>`
		: '';

	const themesHtml = showThemes
		? `<section class="section" id="sec-themes" data-spy>
    ${sectionHead('Temas', 'sec-themes', doc.groups.length > 0)}
    ${groupsHtml || '<p class="empty">Sin temas.</p>'}
  </section>`
		: '';

	const findingsSection = includeFindings
		? `<section class="section" id="sec-findings" data-spy>
    ${sectionHead('Hallazgos', 'sec-findings', findings.length > 0)}
    ${findingsHtml}
  </section>`
		: '';

	const provenance = [meta.agent, meta.modelLabel || meta.model].filter(Boolean).join(' · ');
	const when = formatSavedAt(meta.generatedAt || report.savedAt);
	const subLine = [when, provenance, partial ? 'selección' : ''].filter(Boolean).join(' · ');

	/** Índice lateral: secciones y, debajo de Temas y Hallazgos, cada ítem. */
	const navLink = (href: string, label: string, extra = '') =>
		`<a href="#${href}" data-nav="${href}"${extra}>${label}</a>`;
	const navHtml = !interactive
		? ''
		: `<nav class="side" aria-label="Secciones">
  <p class="brand">diff-review</p>
  <p class="side-title">${escapeHtml(mergeTitle(meta))}</p>
  <ul class="nav">
    <li>${navLink('top', 'Resumen')}</li>
    ${intentHtml ? `<li>${navLink('sec-intent', 'Intención')}</li>` : ''}
    ${notesHtml ? `<li>${navLink('sec-notes', 'Notas')}</li>` : ''}
    ${
			themesHtml
				? `<li>${navLink('sec-themes', `Temas <span class="n">${doc.groups.length}</span>`)}
      <ul class="items">${doc.groups
				.map(
					(g, i) =>
						`<li>${navLink(
							anchorId('t', g.id),
							`<span class="num">${escapeHtml(themeRef(g.id, i + 1))}</span><span class="lbl">${escapeHtml(displayGroupTitle(g.title, g.kind))}</span>`,
							` title="${escapeHtml(displayGroupTitle(g.title, g.kind))}"`
						)}</li>`
				)
				.join('')}</ul></li>`
				: ''
		}
    ${
			findingsSection
				? `<li>${navLink('sec-findings', `Hallazgos <span class="n">${findings.length}</span>`)}
      <ul class="items">${findings
				.map(
					(f, i) =>
						`<li>${navLink(
							anchorId('f', f.id),
							`<span class="dot" style="background:${findingColor(f)}"></span><span class="num">${escapeHtml(findingRef(f.id, i + 1))}</span><span class="lbl">${escapeHtml(fileName(f.file))}${f.line ? `:${f.line}` : ''}</span>`,
							` title="${escapeHtml(f.what)}"`
						)}</li>`
				)
				.join('')}</ul></li>`
				: ''
		}
    ${skippedHtml ? `<li>${navLink('sec-skipped', 'Omitidos')}</li>` : ''}
  </ul>
</nav>`;

	// Sin dependencias: abrir lo que apunta el ancla, plegar/expandir por sección, resaltar
	// en el índice lo que se está leyendo, e imprimir con todo abierto.
	const script = !interactive
		? ''
		: `<script>
(function () {
  function openTarget(id) {
    var el = id && document.getElementById(id);
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
  openTarget(location.hash.slice(1));
  window.addEventListener('hashchange', function () { openTarget(location.hash.slice(1)); });
  document.querySelectorAll('a[data-nav]').forEach(function (a) {
    a.addEventListener('click', function () { openTarget(a.dataset.nav); });
  });
  document.querySelectorAll('button[data-fold]').forEach(function (b) {
    b.addEventListener('click', function () {
      var open = b.dataset.fold === 'open';
      document.querySelectorAll('#' + b.dataset.scope + ' details').forEach(function (d) { d.open = open; });
    });
  });
  window.addEventListener('beforeprint', function () {
    document.querySelectorAll('details').forEach(function (d) { d.dataset.wasOpen = d.open ? '1' : ''; d.open = true; });
  });
  window.addEventListener('afterprint', function () {
    document.querySelectorAll('details').forEach(function (d) { d.open = d.dataset.wasOpen === '1'; });
  });
  var spies = Array.prototype.slice.call(document.querySelectorAll('[data-spy]'));
  var links = {};
  document.querySelectorAll('a[data-nav]').forEach(function (a) { links[a.dataset.nav] = a; });
  var current = null;
  function spy() {
    var hit = null;
    for (var i = 0; i < spies.length; i++) {
      if (spies[i].getBoundingClientRect().top <= 96) hit = spies[i]; else break;
    }
    var id = hit ? hit.id : 'top';
    if (id === current) return;
    current = id;
    document.querySelectorAll('a[data-nav].active, a[data-nav].in').forEach(function (a) { a.classList.remove('active', 'in'); });
    var link = links[id];
    if (!link) return;
    link.classList.add('active');
    var parent = link.closest('.items');
    var sec = parent && parent.parentElement.querySelector(':scope > a');
    if (sec) sec.classList.add('in');
    var box = link.closest('.side');
    if (box) {
      var r = link.getBoundingClientRect(), br = box.getBoundingClientRect();
      if (r.top < br.top + 40 || r.bottom > br.bottom - 20) link.scrollIntoView({ block: 'nearest' });
    }
  }
  var queued = false;
  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; spy(); });
  }, { passive: true });
  document.addEventListener('toggle', spy, true);
  spy();
})();
</script>`;

	return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --text: #16181d;
    --muted: #5b6472;
    --faint: #8b93a1;
    --border: #e2e5ea;
    --bg: #ffffff;
    --elev: #f6f7f9;
    --hover: #eef1f5;
    --accent: #2f6fe0;
    --accent-soft: #e8f0fe;
    --add-bg: #e6f7ec;
    --add-fg: #1f9d55;
    --del-bg: #fbe9e9;
    --del-fg: #c92a2a;
    --hunk: #eef1f5;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", Consolas, monospace;
    --sans: "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html { scroll-padding-top: 24px; }
  body {
    margin: 0;
    font: 14.5px/1.55 var(--sans);
    color: var(--text);
    background: var(--bg);
  }
  .layout { display: grid; grid-template-columns: 264px minmax(0, 1fr); min-height: 100vh; }
  .doc { margin: 0 auto; padding: 40px 28px 64px; max-width: 880px; width: 100%; }
  .layout .doc { padding: 40px 40px 64px; margin: 0; max-width: 920px; }

  /* Índice lateral */
  .side {
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
    padding: 24px 12px 32px; border-right: 1px solid var(--border); background: var(--elev);
    font-size: 12.5px;
  }
  .side .brand { margin: 0 8px 6px; }
  .side-title { margin: 0 8px 16px; font-weight: 650; font-size: 13px; line-height: 1.35; color: var(--text); }
  .nav, .nav ul { list-style: none; margin: 0; padding: 0; }
  .nav > li { margin: 0 0 2px; }
  .nav a {
    display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 4px;
    color: var(--muted); text-decoration: none; min-width: 0;
  }
  .nav > li > a { font-weight: 600; color: var(--text); }
  .nav a:hover { background: var(--hover); color: var(--text); }
  .nav a.in { color: var(--accent); }
  .nav a.active { background: var(--accent-soft); color: var(--accent); }
  .nav .n { margin-left: auto; font-size: 11px; font-weight: 600; color: var(--faint); }
  .nav .items { margin: 2px 0 8px 10px; padding-left: 6px; border-left: 1px solid var(--border); }
  .nav .items a { padding: 3px 8px; font-size: 12px; }
  .nav .items .num { flex-shrink: 0; font-size: 11px; margin: 0; }
  .nav .items .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .nav .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

  .brand {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 0 0 10px;
  }
  h1, .doc-title {
    font-size: 1.65rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
    line-height: 1.25;
  }
  .sub { color: var(--muted); font-size: 12.5px; margin: 0 0 4px; }
  .repo { font-family: var(--mono); font-size: 11.5px; color: var(--muted); word-break: break-all; margin: 2px 0; }
  .repo.muted { color: var(--faint); }
  .stats {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    margin: 18px 0 8px; padding: 12px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  }
  .stat { font-size: 12.5px; color: var(--muted); }
  .stat strong { color: var(--text); font-size: 15px; margin-right: 4px; }
  .chip {
    font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
    padding: 3px 8px; border: 1px solid; border-radius: 2px;
  }
  .chip.blocking, .chip.high { color: #c92a2a; border-color: #f3b4b4; background: #fbe4e4; }
  .chip.med { color: #c44d1a; border-color: #f0c4a8; background: #fff1e8; }
  .chip.low { color: #8b7d2e; border-color: #ddd6a8; background: #f7f4e0; }
  .chip.nit { color: #6b7280; border-color: #d7dbe2; background: #f6f7f9; }
  .sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 36px 0 14px; }
  h2 {
    font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--faint); margin: 0; border: 0; padding: 0;
  }
  .sec-tools { display: flex; gap: 4px; }
  .sec-tools button {
    font: inherit; font-size: 11.5px; color: var(--muted); background: transparent;
    border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; cursor: pointer;
  }
  .sec-tools button:hover { color: var(--text); background: var(--hover); }
  .section p { margin: 0 0 10px; max-width: 68ch; }

  /* Temas y hallazgos: tarjetas plegables */
  .card {
    border: 1px solid var(--border);
    border-left-width: 3px;
    margin: 0 0 10px;
    background: var(--bg);
  }
  .group { border-left-color: var(--border); }
  .card > summary {
    display: flex; flex-wrap: wrap; align-items: center; row-gap: 4px;
    padding: 11px 14px; cursor: pointer; list-style: none;
  }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary:hover { background: var(--elev); }
  .card > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .sum-h { margin: 0; flex: 1; min-width: 0; font-size: inherit; font-weight: inherit; line-height: 1.5; }
  .chev {
    width: 7px; height: 7px; margin: 0 10px 0 2px; flex-shrink: 0;
    border-right: 1.6px solid var(--faint); border-bottom: 1.6px solid var(--faint);
    transform: rotate(-45deg); transition: transform 0.12s ease;
  }
  details[open] > summary .chev { transform: rotate(45deg); }
  .sum-title { font-weight: 650; font-size: 0.98rem; }
  .sum-count { margin-left: auto; padding-left: 12px; font-size: 11.5px; color: var(--faint); }
  .sum-file { font-family: var(--mono); font-size: 11.5px; color: var(--muted); font-weight: 400; }
  .peek {
    flex-basis: 100%; padding-left: 19px; font-size: 13px; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  details[open] > summary .peek { display: none; }
  .card-body { padding: 0 16px 14px 33px; }
  .num { color: var(--faint); font-size: 12px; font-weight: 700; margin-right: 2px; }
  .kind, .badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    border: 1px solid; padding: 1px 6px; margin-right: 3px; display: inline; position: relative; top: -1px;
  }
  .fk { font-weight: 500; color: var(--muted); font-size: 13px; }
  .intent, .why { color: var(--muted); font-size: 13px; margin: 0; max-width: 70ch; }
  .why { font-style: italic; margin-top: 4px; }
  .blocks { margin: 10px 0 0; padding: 0; list-style: none; }
  .blocks li { padding: 8px 0; border-top: 1px solid var(--border); }
  .blocks li:first-child { border-top: 0; }
  .file-ref { font-size: 12.5px; margin-bottom: 2px; font-family: var(--mono); }
  .dir, .loc, .reason { color: var(--faint); font-size: 11.5px; font-weight: 400; }
  .meta { font-size: 12px; color: var(--muted); margin: 0 0 8px; font-family: var(--mono); }
  .what { margin: 0 0 8px; max-width: 70ch; }
  .fix {
    margin: 0 0 10px; padding: 8px 10px; background: #e6f7ec; border-left: 3px solid #1f9d55;
    font-size: 13px; max-width: 70ch;
  }
  .fix strong { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #157a41; margin-bottom: 2px; }
  .empty { color: var(--faint); }
  .skipped { list-style: none; padding: 0; }
  .skipped li { padding: 4px 0; font-size: 12.5px; }
  code { font-family: var(--mono); font-size: 0.9em; }
  .diff {
    margin: 10px 0 0; padding: 0; overflow-x: auto;
    background: var(--elev); border: 1px solid var(--border);
    font: 11.5px/1.45 var(--mono); white-space: pre;
  }
  .diff-hunk { padding: 4px 10px; background: var(--hunk); color: var(--muted); }
  .diff-line { padding: 0 10px; display: flex; gap: 8px; }
  .diff-line .m { width: 1ch; flex-shrink: 0; opacity: 0.7; }
  .diff-line.add { background: var(--add-bg); color: var(--add-fg); }
  .diff-line.del { background: var(--del-bg); color: var(--del-fg); }
  .diff-line.ctx { color: var(--muted); }
  .diff-more { padding: 4px 10px; color: var(--faint); }
  .footer {
    margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--faint);
  }
  @media (max-width: 860px) {
    .layout { display: block; }
    .side { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: 16px 12px; }
    .side .items { display: none; }
    .nav { display: flex; flex-wrap: wrap; gap: 2px; }
    .layout .doc { padding: 28px 16px 48px; }
  }
  @media print {
    .layout { display: block; }
    .side, .sec-tools { display: none; }
    .layout .doc, .doc { padding: 12mm 14mm; max-width: none; }
    .chev, .peek { display: none !important; }
    /* Los marcadores del PDF copian el texto tal como se ve: sin mayúsculas forzadas. */
    h2 { text-transform: none; letter-spacing: 0; font-size: 1.05rem; color: var(--text); }
    .kind, .badge { text-transform: none; }
    .card > summary { padding-left: 16px; }
    .card-body { padding-left: 16px; }
    .card, .diff { break-inside: avoid; }
    /* Un título nunca queda solo al pie de la página: viaja con lo que encabeza. */
    h1, .doc-title, h2, h3, .sec-head, .card > summary { break-after: avoid; break-inside: avoid; }
    .fix { background: #f0f0f0 !important; }
  }
</style>
</head>
<body>
${interactive ? '<div class="layout">' : ''}
${navHtml}
<main class="doc" id="top" data-spy>
  <p class="brand">diff-review</p>
  ${
		// En el PDF el título no es h1: si lo fuera, Chrome lo pondría como marcador padre de todas las secciones.
		interactive
			? `<h1>${escapeHtml(mergeTitle(meta))}</h1>`
			: `<p class="doc-title">${escapeHtml(mergeTitle(meta))}</p>`
	}
  <p class="sub">${escapeHtml(subLine)}</p>
  ${repoLine}
  ${statsHtml}
  ${intentHtml}
  ${notesHtml}
  ${themesHtml}
  ${findingsSection}
  ${skippedHtml}
  <p class="footer">Generado con diff-review</p>
</main>
${interactive ? '</div>' : ''}
${script}
</body>
</html>`;
}


export async function downloadReport(
	report: SavedReport,
	format: ExportFormat,
	options: ExportOptions = {}
) {
	const sections = resolveSections(options);
	const base = slugBase(report);
	const partial =
		options.sections?.length && options.sections.length < DEFAULT_EXPORT_SECTIONS.length;
	const suffix =
		format !== 'json' && (partial || options.mode === 'summary') ? '-parcial' : '';

	if (format === 'json') {
		triggerDownload(
			new Blob([serializeReviewPayload(report.document, report.meta)], {
				type: 'application/json;charset=utf-8'
			}),
			`${base}.json`
		);
		return;
	}
	if (format === 'md') {
		triggerDownload(
			new Blob([buildMarkdown(report, { ...options, sections: [...sections] })], {
				type: 'text/markdown;charset=utf-8'
			}),
			`${base}${suffix}.md`
		);
		return;
	}
	const html = buildHtml(report, { ...options, sections: [...sections] }, { interactive: format === 'html' });
	if (format === 'html') {
		triggerDownload(new Blob([html], { type: 'text/html;charset=utf-8' }), `${base}${suffix}.html`);
		return;
	}
	try {
		triggerDownload(await requestPdf(html), `${base}${suffix}.pdf`);
	} catch {
		// Sin navegador en el servidor (o falló): queda el diálogo de impresión del navegador.
		printHtml(html);
	}
}

/** Pide al servidor el PDF impreso con Chrome/Edge headless (con marcadores). */
async function requestPdf(html: string): Promise<Blob> {
	const res = await fetch('/api/pdf', {
		method: 'POST',
		headers: { 'content-type': 'text/html;charset=utf-8' },
		body: html
	});
	if (!res.ok) throw new Error(`PDF: ${res.status}`);
	return res.blob();
}

/** Imprime el HTML desde un iframe oculto (no lo frena el bloqueador de ventanas). */
function printHtml(html: string) {
	const frame = document.createElement('iframe');
	frame.setAttribute('aria-hidden', 'true');
	frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
	frame.srcdoc = html;
	frame.addEventListener('load', () => {
		setTimeout(() => {
			try {
				frame.contentWindow?.focus();
				frame.contentWindow?.print();
			} finally {
				setTimeout(() => frame.remove(), 1000);
			}
		}, 50);
	});
	document.body.appendChild(frame);
}
