import hljs from 'highlight.js/lib/common';
import type { LineRange } from './types';

export type DiffLineKind = 'add' | 'del' | 'ctx';

/** Tramo de una línea, en caracteres [start, end), que cambió respecto de su par. */
export type Mark = { start: number; end: number };

export type DiffLine = {
	kind: DiffLineKind;
	text: string;
	oldNo: number | null;
	newNo: number | null;
	/** Solo en pares borrado/agregado emparejados: qué parte de la línea cambió. */
	marks?: Mark[];
};

export type DiffHunk = {
	index: number;
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parte un diff unificado (arranca en la primera línea `@@`) en hunks con numeración resuelta. */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	if (!diff) return hunks;
	let current: DiffHunk | null = null;
	let oldNo = 0;
	let newNo = 0;

	// El salto final no es una línea del archivo: si no se saca, aparece un contexto fantasma.
	for (const raw of diff.replace(/\n$/, '').split('\n')) {
		const match = HUNK_RE.exec(raw);
		if (match) {
			current = {
				index: hunks.length,
				header: match[5].trim(),
				oldStart: Number(match[1]),
				oldCount: match[2] === undefined ? 1 : Number(match[2]),
				newStart: Number(match[3]),
				newCount: match[4] === undefined ? 1 : Number(match[4]),
				lines: []
			};
			oldNo = current.oldStart;
			newNo = current.newStart;
			hunks.push(current);
			continue;
		}
		if (!current) continue;
		// `\ No newline at end of file` y separadores de git no son líneas del archivo.
		if (raw.startsWith('\\')) continue;
		if (raw.startsWith('diff --git') || raw.startsWith('index ')) continue;

		const marker = raw.charAt(0);
		const text = raw.slice(1);
		if (marker === '+') {
			current.lines.push({ kind: 'add', text, oldNo: null, newNo });
			newNo += 1;
		} else if (marker === '-') {
			current.lines.push({ kind: 'del', text, oldNo, newNo: null });
			oldNo += 1;
		} else if (marker === ' ' || raw === '') {
			current.lines.push({ kind: 'ctx', text, oldNo, newNo });
			oldNo += 1;
			newNo += 1;
		}
	}

	for (const hunk of hunks) annotateIntraLine(hunk.lines);
	return hunks;
}

const TOKEN_RE = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;

function tokenize(text: string) {
	const out: { text: string; at: number }[] = [];
	let at = 0;
	for (const token of text.match(TOKEN_RE) ?? []) {
		out.push({ text: token, at });
		at += token.length;
	}
	return out;
}

type Token = { text: string; at: number };

/** Une marcas pegadas para no cortar el subrayado token por token. */
function mergeMarks(marks: Mark[]): Mark[] {
	const out: Mark[] = [];
	for (const m of marks) {
		const last = out[out.length - 1];
		if (last && last.end === m.start) last.end = m.end;
		else out.push({ ...m });
	}
	return out;
}

function markOf(token: Token): Mark {
	return { start: token.at, end: token.at + token.text.length };
}

/** Tope de celdas de la tabla de LCS: arriba de esto no vale la pena el detalle. */
const LCS_BUDGET = 40_000;

/**
 * Qué cambió dentro de un par borrado/agregado. Recorta los tokens iguales de los bordes y
 * sobre el resto corre un LCS por tokens, así marca solo los pedazos que se tocaron y no
 * todo el tramo entre el primer y el último cambio. Si las dos líneas casi no comparten
 * texto no marca nada: pintar la línea entera no dice nada que el color de fondo no diga.
 */
export function intraLineMarks(oldText: string, newText: string): { old: Mark[]; new: Mark[] } {
	if (oldText === newText || !oldText || !newText) return { old: [], new: [] };
	const a = tokenize(oldText);
	const b = tokenize(newText);
	let head = 0;
	while (head < a.length && head < b.length && a[head].text === b[head].text) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail].text === b[b.length - 1 - tail].text
	)
		tail++;

	const aMid = a.slice(head, a.length - tail);
	const bMid = b.slice(head, b.length - tail);
	const n = aMid.length;
	const m = bMid.length;
	if (!n && !m) return { old: [], new: [] };
	if (!n || !m || n * m > LCS_BUDGET) {
		// Un lado no tiene nada propio (inserción o borrado puro) o la línea es enorme:
		// alcanza con marcar el tramo del medio de una.
		const span = (mid: Token[]): Mark[] =>
			mid.length ? [{ start: mid[0].at, end: mid[mid.length - 1].at + mid[mid.length - 1].text.length }] : [];
		return head || tail ? { old: span(aMid), new: span(bMid) } : { old: [], new: [] };
	}

	// dp[i][j] = largo del LCS de aMid[i..] y bMid[j..]
	const dp = new Int32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * (m + 1) + j] =
				aMid[i].text === bMid[j].text
					? dp[(i + 1) * (m + 1) + j + 1] + 1
					: Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
		}
	}

	const oldMarks: Mark[] = [];
	const newMarks: Mark[] = [];
	let common = 0;
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (aMid[i].text === bMid[j].text) {
			common += aMid[i].text.length;
			i++;
			j++;
		} else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
			oldMarks.push(markOf(aMid[i++]));
		} else {
			newMarks.push(markOf(bMid[j++]));
		}
	}
	while (i < n) oldMarks.push(markOf(aMid[i++]));
	while (j < m) newMarks.push(markOf(bMid[j++]));

	// Los bordes recortados también son texto compartido: cuentan para decidir si las
	// dos líneas son variantes de la misma o dos líneas sin relación.
	for (let k = 0; k < head; k++) common += a[k].text.length;
	for (let k = 0; k < tail; k++) common += a[a.length - 1 - k].text.length;
	if (common / Math.max(oldText.length, newText.length) < 0.3) return { old: [], new: [] };

	return { old: mergeMarks(oldMarks), new: mergeMarks(newMarks) };
}

/** Empareja el k-ésimo borrado con el k-ésimo agregado de cada tramo y les cuelga las marcas. */
function annotateIntraLine(lines: DiffLine[]) {
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind !== 'del') {
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
		const adds: DiffLine[] = [];
		while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
		for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
			const marks = intraLineMarks(dels[k].text, adds[k].text);
			if (marks.old.length) dels[k].marks = marks.old;
			if (marks.new.length) adds[k].marks = marks.new;
		}
	}
}

export function hunkLineCount(hunks: DiffHunk[]) {
	let total = 0;
	for (const hunk of hunks) total += hunk.lines.length;
	return total;
}

/** Última línea de la post imagen que cubre el hunk. */
export function hunkNewEnd(hunk: DiffHunk) {
	return hunk.newStart + Math.max(hunk.newCount, 1) - 1;
}

export function hunkOldEnd(hunk: DiffHunk) {
	return hunk.oldStart + Math.max(hunk.oldCount, 1) - 1;
}

export function hunkCovers(hunk: DiffHunk, range: LineRange) {
	const start = range.side === 'new' ? hunk.newStart : hunk.oldStart;
	const end = range.side === 'new' ? hunkNewEnd(hunk) : hunkOldEnd(hunk);
	return range.start <= end && range.end >= start;
}

export function lineInRange(line: DiffLine, range: LineRange) {
	const no = range.side === 'new' ? line.newNo : line.oldNo;
	if (no === null) return false;
	return no >= range.start && no <= range.end;
}

const EXTENSIONS: Record<string, string> = {
	bash: 'bash',
	c: 'c',
	cc: 'cpp',
	cjs: 'javascript',
	cpp: 'cpp',
	cs: 'csharp',
	css: 'css',
	cts: 'typescript',
	go: 'go',
	graphql: 'graphql',
	gql: 'graphql',
	h: 'cpp',
	hpp: 'cpp',
	htm: 'xml',
	html: 'xml',
	ini: 'ini',
	java: 'java',
	js: 'javascript',
	json: 'json',
	jsonc: 'json',
	jsx: 'javascript',
	kt: 'kotlin',
	less: 'less',
	lua: 'lua',
	md: 'markdown',
	mdx: 'markdown',
	mjs: 'javascript',
	mts: 'typescript',
	php: 'php',
	pl: 'perl',
	py: 'python',
	rb: 'ruby',
	rs: 'rust',
	scss: 'scss',
	sh: 'bash',
	sql: 'sql',
	svelte: 'xml',
	svg: 'xml',
	swift: 'swift',
	toml: 'ini',
	ts: 'typescript',
	tsx: 'typescript',
	vue: 'xml',
	xml: 'xml',
	yaml: 'yaml',
	yml: 'yaml',
	zsh: 'bash'
};

const FILENAMES: Record<string, string> = {
	dockerfile: 'bash',
	makefile: 'makefile',
	'.gitignore': 'bash',
	'.env': 'ini'
};

/** Lenguaje de highlight.js para un path, o null si conviene texto plano. */
export function languageFor(path: string): string | null {
	const base = (path.split('/').pop() ?? path).toLowerCase();
	const byName = FILENAMES[base];
	if (byName && hljs.getLanguage(byName)) return byName;
	const dot = base.lastIndexOf('.');
	if (dot < 0) return null;
	const lang = EXTENSIONS[base.slice(dot + 1)];
	if (!lang) return null;
	return hljs.getLanguage(lang) ? lang : null;
}

export function escapeHtml(text: string) {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/**
 * Lenguajes donde highlight.js no marca los tipos en uso: reconoce el nombre en la
 * declaración (`class Foo`) y nada más, así que `Guid id` o `Task<Bar>` quedan en gris.
 * En estos la convención de nombres alcanza para deducirlos.
 */
const TYPE_LANGS = new Set(['csharp', 'java', 'kotlin']);

const TYPE_CLASS = 'hljs-title class_';

function isIdentChar(ch: string) {
	return /[A-Za-z0-9_]/.test(ch);
}

/**
 * Identificadores que parecen nombres de tipo dentro de un tramo de texto plano (ya
 * escapado). Marca solo los casos con contexto claro —interfaz `IFoo`, genérico `Foo<…>`,
 * argumento de genérico, declaración `Foo bar`, `new Foo`— y nunca lo que viene después de
 * un punto, que es acceso a miembro y no un tipo.
 */
function typeRanges(chunk: string, prevChar: string, afterNew: boolean): Mark[] {
	const out: Mark[] = [];
	let i = 0;
	let angle = 0;
	let prev = prevChar.trim() || prevChar;
	let prevRaw = prevChar;
	let first = true;
	while (i < chunk.length) {
		if (chunk.startsWith('&lt;', i)) {
			// Solo `Foo<` pegado abre genérico; `count < Limit` es una comparación.
			if (isIdentChar(prevRaw)) angle++;
			prev = '<';
			prevRaw = '<';
			i += 4;
			continue;
		}
		if (chunk.startsWith('&gt;', i)) {
			if (angle) angle--;
			prev = '>';
			prevRaw = '>';
			i += 4;
			continue;
		}
		const ch = chunk[i];
		if (/[A-Za-z_]/.test(ch)) {
			let j = i;
			while (j < chunk.length && isIdentChar(chunk[j])) j++;
			const word = chunk.slice(i, j);
			const rest = chunk.slice(j);
			const looksType =
				/^[A-Z]/.test(word) &&
				prev !== '.' &&
				(/^I[A-Z]/.test(word) ||
					rest.startsWith('&lt;') ||
					angle > 0 ||
					// declaración: `Foo bar`, `Foo? bar`, `Foo[] bar`
					/^\??(\[[,\s]*\])?\??\s+[a-z_][A-Za-z0-9_]*/.test(rest) ||
					(first && afterNew));
			if (looksType) out.push({ start: i, end: j });
			prev = word[word.length - 1];
			prevRaw = prev;
			first = false;
			i = j;
			continue;
		}
		if (!/\s/.test(ch)) prev = ch;
		prevRaw = ch;
		i += 1;
	}
	return out;
}

function wrapRanges(chunk: string, ranges: Mark[]): string {
	let out = '';
	let at = 0;
	for (const r of ranges) {
		out += chunk.slice(at, r.start) + `<span class="${TYPE_CLASS}">` + chunk.slice(r.start, r.end) + '</span>';
		at = r.end;
	}
	return out + chunk.slice(at);
}

/** Pasada extra sobre el HTML del resaltador: colorea los tipos que highlight.js dejó sin marcar. */
function markTypeNames(html: string): string {
	let out = '';
	let i = 0;
	let depth = 0;
	let prevChar = '';
	let lastKeyword = '';
	let keywordDepth = -1;
	while (i < html.length) {
		if (html[i] === '<') {
			const close = html.indexOf('>', i);
			const tag = close < 0 ? html.slice(i) : html.slice(i, close + 1);
			if (tag.startsWith('</')) {
				depth = Math.max(0, depth - 1);
				if (depth < keywordDepth) keywordDepth = -1;
			} else if (!tag.endsWith('/>')) {
				depth += 1;
				if (tag.includes('hljs-keyword')) {
					keywordDepth = depth;
					lastKeyword = '';
				}
			}
			out += tag;
			i += tag.length;
			continue;
		}
		const next = html.indexOf('<', i);
		const chunk = html.slice(i, next < 0 ? html.length : next);
		if (depth > 0) {
			// Ya clasificado por el resaltador (string, comentario, keyword): no se toca.
			if (keywordDepth > 0) lastKeyword += chunk;
			out += chunk;
		} else {
			out += wrapRanges(chunk, typeRanges(chunk, prevChar, lastKeyword.trim() === 'new'));
			lastKeyword = '';
		}
		if (chunk) prevChar = chunk[chunk.length - 1];
		i += chunk.length;
	}
	return out;
}

const cache = new Map<string, string>();
const CACHE_LIMIT = 20000;

/**
 * Resalta una línea suelta (sin el `+`/`-` del diff). Si el lenguaje no está
 * registrado, devuelve el texto escapado en vez de reventar.
 */
export function highlightLine(text: string, language: string | null): string {
	if (!text) return '';
	if (!language) return escapeHtml(text);
	const key = `${language}\u0000${text}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	let html: string;
	try {
		html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
		if (TYPE_LANGS.has(language)) html = markTypeNames(html);
	} catch {
		html = escapeHtml(text);
	}
	if (cache.size > CACHE_LIMIT) cache.clear();
	cache.set(key, html);
	return html;
}

/**
 * Envuelve en un span de clase `cls` los tramos marcados de una línea ya resaltada. Cuenta
 * caracteres visibles (una entidad `&amp;` vale uno) y cierra el span antes de cada tag para
 * no cruzar los del resaltador, que dejaría HTML mal anidado.
 */
export function applyMarks(html: string, marks: Mark[] | undefined, cls: string): string {
	if (!marks?.length) return html;
	let out = '';
	let visible = 0;
	let i = 0;
	let open = false;
	while (i < html.length) {
		if (html[i] === '<') {
			const close = html.indexOf('>', i);
			const tag = close < 0 ? html.slice(i) : html.slice(i, close + 1);
			if (open) {
				out += '</span>';
				open = false;
			}
			out += tag;
			i += tag.length;
			continue;
		}
		let piece = html[i];
		if (piece === '&') {
			const semi = html.indexOf(';', i);
			if (semi > i && semi - i <= 8) piece = html.slice(i, semi + 1);
		}
		const inside = marks.some((m) => visible >= m.start && visible < m.end);
		if (inside && !open) {
			out += `<span class="${cls}">`;
			open = true;
		} else if (!inside && open) {
			out += '</span>';
			open = false;
		}
		out += piece;
		i += piece.length;
		visible += 1;
	}
	if (open) out += '</span>';
	return out;
}

/** Línea resaltada por lenguaje y, si el par lo permite, con el fragmento cambiado marcado. */
export function renderLine(text: string, language: string | null, marks?: Mark[]): string {
	return applyMarks(highlightLine(text, language), marks, 'chg');
}

export function splitPath(path: string) {
	const at = path.lastIndexOf('/');
	if (at < 0) return { dir: '', base: path };
	return { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
}

export type SplitCell = {
	blank: boolean;
	no: string;
	text: string;
	kind: DiffLineKind | 'blank';
	marks?: Mark[];
};

export type SplitRow = { left: SplitCell; right: SplitCell };

const BLANK_CELL: SplitCell = { blank: true, no: '', text: '', kind: 'blank' };

function cellOf(line: DiffLine, side: 'old' | 'new'): SplitCell {
	return {
		blank: false,
		no: String(side === 'old' ? line.oldNo : line.newNo),
		text: line.text,
		kind: line.kind,
		marks: line.marks
	};
}

/**
 * Arma las filas lado a lado del modo split: corre borrados y agregados en paralelo, de
 * modo que el k-ésimo borrado queda enfrentado al k-ésimo agregado y lo que sobra de un
 * lado queda contra una celda vacía. Las dos celdas de una fila se dibujan en la misma
 * fila de la grilla, así que no hace falta alto fijo ni sincronizar scroll.
 */
export function buildHunkSplit(hunk: DiffHunk): { rows: SplitRow[] } {
	const rows: SplitRow[] = [];
	const lines = hunk.lines;
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind === 'ctx') {
			const l = lines[i];
			rows.push({ left: cellOf(l, 'old'), right: cellOf(l, 'new') });
			i++;
			continue;
		}
		const delRun: DiffLine[] = [];
		while (i < lines.length && lines[i].kind === 'del') {
			delRun.push(lines[i]);
			i++;
		}
		const addRun: DiffLine[] = [];
		while (i < lines.length && lines[i].kind === 'add') {
			addRun.push(lines[i]);
			i++;
		}
		if (!delRun.length && !addRun.length) {
			i++;
			continue;
		}
		const n = Math.max(delRun.length, addRun.length);
		for (let k = 0; k < n; k++) {
			const d = delRun[k];
			const a = addRun[k];
			rows.push({
				left: d ? cellOf(d, 'old') : BLANK_CELL,
				right: a ? cellOf(a, 'new') : BLANK_CELL
			});
		}
	}
	return { rows };
}

/** Cuántas líneas de contexto revela cada clic en los botones de un hueco. */
export const CONTEXT_STEP = 20;

/** Tramo del archivo que el diff no muestra, entre dos hunks (o en los bordes). */
export type DiffGap = {
	/** Estable frente a expandir/plegar: la primera línea oculta del hueco original. */
	key: string;
	start: number;
	end: number;
	hidden: number;
	/** Hay hunk después: se puede revelar hacia arriba, pegado a su primera línea. */
	canUp: boolean;
	/** Hay hunk antes: se puede revelar hacia abajo, pegado a su última línea. */
	canDown: boolean;
};

export type DiffSegment = { kind: 'gap'; gap: DiffGap } | { kind: 'hunk'; hunk: DiffHunk };

/** Líneas ya reveladas de cada hueco, por `DiffGap.key`. */
export type RevealState = Record<string, { up: number; down: number }>;

export function gapKey(start: number) {
	return `g${start}`;
}

/** Última línea de la post imagen dentro del hunk; para un borrado puro, la de arriba. */
function lastNewNo(hunk: DiffHunk) {
	for (let i = hunk.lines.length - 1; i >= 0; i--) {
		const no = hunk.lines[i].newNo;
		if (no != null) return no;
	}
	return hunk.newStart;
}

function firstNewNo(hunk: DiffHunk) {
	for (const line of hunk.lines) {
		if (line.newNo != null) return line.newNo;
	}
	return hunk.newStart + 1;
}

/** `oldNo - newNo` al salir del hunk: las líneas del hueco son contexto, así que el corrimiento se mantiene. */
function tailDelta(hunk: DiffHunk) {
	for (let i = hunk.lines.length - 1; i >= 0; i--) {
		const line = hunk.lines[i];
		if (line.oldNo != null && line.newNo != null) return line.oldNo - line.newNo;
	}
	return hunk.oldStart + hunk.oldCount - (hunk.newStart + hunk.newCount);
}

/** `oldNo - newNo` al entrar al hunk. */
function headDelta(hunk: DiffHunk) {
	for (const line of hunk.lines) {
		if (line.oldNo != null && line.newNo != null) return line.oldNo - line.newNo;
	}
	return hunk.oldStart - hunk.newStart;
}

function contextLines(fileLines: string[], from: number, to: number, delta: number): DiffLine[] {
	const out: DiffLine[] = [];
	for (let no = Math.max(1, from); no <= to; no++) {
		const text = fileLines[no - 1];
		if (text === undefined) break;
		out.push({ kind: 'ctx', text, oldNo: no + delta, newNo: no });
	}
	return out;
}

function withContext(hunk: DiffHunk, before: DiffLine[], after: DiffLine[]): DiffHunk {
	if (!before.length && !after.length) return hunk;
	const head = before[0];
	return {
		...hunk,
		lines: [...before, ...hunk.lines, ...after],
		oldStart: head?.oldNo ?? hunk.oldStart,
		newStart: head?.newNo ?? hunk.newStart,
		oldCount: hunk.oldCount + before.length + after.length,
		newCount: hunk.newCount + before.length + after.length
	};
}

function mergeHunks(a: DiffHunk, b: DiffHunk): DiffHunk {
	return {
		...a,
		lines: [...a.lines, ...b.lines],
		oldCount: a.oldCount + b.oldCount,
		newCount: a.newCount + b.newCount
	};
}

/**
 * Intercala los hunks con los huecos del archivo y les pega el contexto ya revelado.
 * Sin `fileLines` (todavía no se leyó el archivo del repo) igual devuelve los huecos
 * intermedios, que se calculan solo con la numeración de los hunks; el tramo final
 * necesita saber cuánto mide el archivo, así que aparece recién después de cargarlo.
 */
export function buildDiffSegments(
	hunks: DiffHunk[],
	fileLines: string[] | null,
	reveal: RevealState
): DiffSegment[] {
	if (!hunks.length) return [];
	const before: DiffLine[][] = hunks.map(() => []);
	const after: DiffLine[][] = hunks.map(() => []);
	const gapAt: (DiffGap | null)[] = [];

	for (let i = 0; i <= hunks.length; i++) {
		const prev = i > 0 ? hunks[i - 1] : null;
		const next = i < hunks.length ? hunks[i] : null;
		const start = prev ? lastNewNo(prev) + 1 : 1;
		const end = next ? firstNewNo(next) - 1 : (fileLines ? fileLines.length : 0);
		if (end < start) {
			gapAt.push(null);
			continue;
		}
		const len = end - start + 1;
		const state = reveal[gapKey(start)] ?? { up: 0, down: 0 };
		const up = next ? Math.min(state.up, len) : 0;
		const down = prev ? Math.min(state.down, len - up) : 0;
		if (fileLines) {
			if (down && prev) {
				after[i - 1] = contextLines(fileLines, start, start + down - 1, tailDelta(prev));
			}
			if (up && next) {
				before[i] = contextLines(fileLines, end - up + 1, end, headDelta(next));
			}
		}
		const hidden = len - up - down;
		gapAt.push(
			hidden > 0
				? { key: gapKey(start), start: start + down, end: end - up, hidden, canUp: !!next, canDown: !!prev }
				: null
		);
	}

	const segments: DiffSegment[] = [];
	for (let i = 0; i < hunks.length; i++) {
		const gap = gapAt[i];
		const hunk = withContext(hunks[i], before[i], after[i]);
		const prev = segments[segments.length - 1];
		// Sin hueco entre medio los dos hunks son texto corrido: un `@@` ahí haría de corte falso.
		if (!gap && i > 0 && prev?.kind === 'hunk') {
			segments[segments.length - 1] = { kind: 'hunk', hunk: mergeHunks(prev.hunk, hunk) };
			continue;
		}
		if (gap) segments.push({ kind: 'gap', gap });
		segments.push({ kind: 'hunk', hunk });
	}
	const tail = gapAt[hunks.length];
	if (tail) segments.push({ kind: 'gap', gap: tail });
	return segments;
}
