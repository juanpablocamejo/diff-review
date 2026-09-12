import { hunkCovers, lineInRange, parseUnifiedDiff, type DiffLine } from './diff';
import { serializeReviewPayload } from './document';
import { displayGroupTitle, findingKindLabel, kindLabel, severityLabel } from './labels';
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

export type ExportOptions = {
	/** summary = sin snippets de diff; full = con recortes por hallazgo. */
	mode?: ExportMode;
};

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
	const mode = options.mode ?? 'full';
	const { meta, document: doc } = report;
	const stats = severityStats(doc);
	const findings = sortedFindings(doc);
	const lines: string[] = [];

	lines.push(`# Review · \`${mergeTitle(meta)}\``);
	lines.push('');
	lines.push(`> Generado con **diff-review** · ${formatSavedAt(report.savedAt)}`);
	if (shortRepo(meta)) lines.push(`> Repo: \`${shortRepo(meta)}\``);
	lines.push('');

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

	lines.push('## Intención');
	lines.push('');
	lines.push(doc.intent?.trim() || '_Sin intención._');
	lines.push('');

	if (doc.notes?.length) {
		lines.push('## Notas');
		lines.push('');
		for (const n of doc.notes) lines.push(`- ${n}`);
		lines.push('');
	}

	lines.push('## Temas');
	lines.push('');
	doc.groups.forEach((g, i) => {
		const title = displayGroupTitle(g.title, g.kind);
		lines.push(`### #${i + 1} · ${kindLabel(g.kind)} — ${title}`);
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
			lines.push(`### #${i + 1} · ${badge} · ${findingKindLabel(f.kind)}`);
			lines.push('');
			if (f.blocking) lines.push('> [!CAUTION]');
			else if (f.severity === 'high') lines.push('> [!WARNING]');
			if (f.blocking || f.severity === 'high') {
				lines.push(`> ${f.what}`);
				lines.push('');
			}
			lines.push(`\`${name}${f.line ? ':' + f.line : ''}\`${dir ? ` · \`${dir}\`` : ''} · ${f.class}`);
			lines.push('');
			if (!(f.blocking || f.severity === 'high')) {
				lines.push(f.what);
				lines.push('');
			}
			if (f.fix?.trim()) {
				lines.push(`**Sugerencia:** ${f.fix.trim()}`);
				lines.push('');
			}
			if (mode === 'full') {
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

	if (doc.skipped?.length) {
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

/** HTML autocontenido (también base del PDF vía print). */
export function buildHtml(report: SavedReport, options: ExportOptions = {}): string {
	const mode = options.mode ?? 'full';
	const { meta, document: doc } = report;
	const title = `Review · ${mergeTitle(meta)}`;
	const stats = severityStats(doc);
	const findings = sortedFindings(doc);

	const chips = [
		stats.blocking ? `<span class="chip blocking">${stats.blocking} bloqueante${stats.blocking === 1 ? '' : 's'}</span>` : '',
		stats.high ? `<span class="chip high">${stats.high} alta</span>` : '',
		stats.med ? `<span class="chip med">${stats.med} media</span>` : '',
		stats.low ? `<span class="chip low">${stats.low} baja</span>` : '',
		stats.nit ? `<span class="chip nit">${stats.nit} detalle</span>` : ''
	]
		.filter(Boolean)
		.join('');

	const groupsHtml = doc.groups
		.map((g, i) => {
			const gTitle = escapeHtml(displayGroupTitle(g.title, g.kind));
			const kind = (g.kind in KIND_COLOR ? g.kind : 'chore') as GroupKind;
			const blocks = doc.blocks.filter((b) => b.group === g.id);
			const blockLis = blocks
				.map((b) => {
					const loc = b.lines || (b.start && b.end ? `L${b.start}-${b.end}` : '');
					const why = b.why?.trim()
						? `<div class="why">${escapeHtml(b.why.trim())}</div>`
						: '';
					const name = fileName(b.file);
					const dir = fileDir(b.file);
					return `<li>
  <div class="file-ref"><strong>${escapeHtml(name)}</strong>${dir ? ` <span class="dir">${escapeHtml(dir)}</span>` : ''}${loc ? ` <span class="loc">${escapeHtml(loc)}</span>` : ''}</div>
  <div>${escapeHtml(b.what)}</div>${why}
</li>`;
				})
				.join('');
			return `<section class="group">
  <h3><span class="num">#${i + 1}</span> <span class="kind" style="color:${KIND_COLOR[kind]};border-color:${KIND_COLOR[kind]}33">${escapeHtml(kindLabel(g.kind))}</span> ${gTitle}</h3>
  ${g.intent?.trim() ? `<p class="intent">${escapeHtml(g.intent.trim())}</p>` : ''}
  ${blocks.length ? `<ul class="blocks">${blockLis}</ul>` : ''}
</section>`;
		})
		.join('\n');

	const findingsHtml = !findings.length
		? '<p class="empty">Sin hallazgos.</p>'
		: findings
				.map((f, i) => {
					const badge = findingBadge(f);
					const color = findingColor(f);
					const name = fileName(f.file);
					const dir = fileDir(f.file);
					const loc = f.line ? `:${f.line}` : '';
					const snippet =
						mode === 'full' ? findingDiffSnippet(doc, f) : null;
					return `<article class="finding" style="border-left-color:${color}">
  <h3><span class="num">#${i + 1}</span> <span class="badge" style="color:${color};border-color:${color}55;background:${color}14">${escapeHtml(badge)}</span> <span class="fk">${escapeHtml(findingKindLabel(f.kind))}</span></h3>
  <div class="meta"><strong>${escapeHtml(name)}${escapeHtml(loc)}</strong>${dir ? ` <span class="dir">${escapeHtml(dir)}</span>` : ''} · ${escapeHtml(f.class)}</div>
  <p class="what">${escapeHtml(f.what)}</p>
  ${f.fix?.trim() ? `<p class="fix"><strong>Sugerencia</strong> ${escapeHtml(f.fix.trim())}</p>` : ''}
  ${snippet ? htmlDiffSnippet(snippet) : ''}
</article>`;
				})
				.join('\n');

	const notesHtml = doc.notes?.length
		? `<section class="section"><h2>Notas</h2><ul>${doc.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></section>`
		: '';

	const skippedHtml = doc.skipped?.length
		? `<section class="section"><h2>Omitidos</h2><ul class="skipped">${doc.skipped.map((s) => `<li><code>${escapeHtml(s.file)}</code> <span class="reason">${escapeHtml(s.reason)}</span></li>`).join('')}</ul></section>`
		: '';

	const repoLine = shortRepo(meta)
		? `<div class="repo">${escapeHtml(shortRepo(meta))}</div>`
		: '';

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
    --add-bg: #e6f7ec;
    --add-fg: #1f9d55;
    --del-bg: #fbe9e9;
    --del-fg: #c92a2a;
    --hunk: #eef1f5;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", Consolas, monospace;
    --sans: "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 40px 28px 64px;
    max-width: 880px;
    font: 14.5px/1.55 var(--sans);
    color: var(--text);
    background: var(--bg);
  }
  .brand {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 0 0 10px;
  }
  h1 {
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
  h2 {
    font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--faint); margin: 36px 0 14px; border: 0; padding: 0;
  }
  h3 { font-size: 1rem; margin: 0 0 8px; font-weight: 650; }
  .section p { margin: 0 0 10px; max-width: 68ch; }
  .group, .finding {
    border: 1px solid var(--border);
    border-left-width: 3px;
    padding: 14px 16px;
    margin: 0 0 12px;
    background: var(--bg);
  }
  .group { border-left-color: var(--border); }
  .finding { border-left-width: 3px; }
  .num { color: var(--faint); font-size: 12px; font-weight: 700; margin-right: 4px; }
  .kind, .badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    border: 1px solid; padding: 1px 6px; margin-right: 6px; display: inline-block;
  }
  .fk { font-weight: 500; color: var(--muted); font-size: 13px; }
  .intent, .why { color: var(--muted); font-size: 13px; margin: 6px 0 0; max-width: 70ch; }
  .why { font-style: italic; }
  .blocks { margin: 10px 0 0; padding: 0; list-style: none; }
  .blocks li { padding: 8px 0; border-top: 1px solid var(--border); }
  .blocks li:first-child { border-top: 0; padding-top: 0; }
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
  @media print {
    body { padding: 12mm 14mm; max-width: none; }
    .group, .finding, .diff { break-inside: avoid; }
    .fix { background: #f0f0f0 !important; }
  }
</style>
</head>
<body>
  <p class="brand">diff-review</p>
  <h1>${escapeHtml(mergeTitle(meta))}</h1>
  <p class="sub">${escapeHtml(formatSavedAt(report.savedAt))}${mode === 'summary' ? ' · resumen' : ''}</p>
  ${repoLine}
  <div class="stats">
    <span class="stat"><strong>${doc.groups.length}</strong> temas</span>
    <span class="stat"><strong>${doc.findings.length}</strong> hallazgos</span>
    ${chips}
  </div>
  <section class="section">
    <h2>Intención</h2>
    <p>${escapeHtml(doc.intent?.trim() || 'Sin intención.')}</p>
  </section>
  ${notesHtml}
  <section class="section">
    <h2>Temas</h2>
    ${groupsHtml || '<p class="empty">Sin temas.</p>'}
  </section>
  <section class="section">
    <h2>Hallazgos</h2>
    ${findingsHtml}
  </section>
  ${skippedHtml}
  <p class="footer">Generado con diff-review${mode === 'full' ? ' · export completo con snippets de diff' : ' · export resumen'}</p>
</body>
</html>`;
}

export function downloadReport(
	report: SavedReport,
	format: ExportFormat,
	options: ExportOptions = {}
) {
	const mode = options.mode ?? 'full';
	const base = slugBase(report);
	const suffix = mode === 'summary' && format !== 'json' ? '-resumen' : '';

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
			new Blob([buildMarkdown(report, { mode })], { type: 'text/markdown;charset=utf-8' }),
			`${base}${suffix}.md`
		);
		return;
	}
	const html = buildHtml(report, { mode });
	if (format === 'html') {
		triggerDownload(new Blob([html], { type: 'text/html;charset=utf-8' }), `${base}${suffix}.html`);
		return;
	}
	const w = window.open('', '_blank');
	if (!w) {
		triggerDownload(new Blob([html], { type: 'text/html;charset=utf-8' }), `${base}${suffix}.html`);
		return;
	}
	w.document.open();
	w.document.write(html);
	w.document.close();
	w.focus();
	const runPrint = () => {
		try {
			w.print();
		} finally {
			w.close();
		}
	};
	if (w.document.readyState === 'complete') setTimeout(runPrint, 50);
	else w.addEventListener('load', () => setTimeout(runPrint, 50));
}
