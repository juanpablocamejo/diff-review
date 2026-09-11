import type { ReviewDocument } from './types';

/**
 * Mismo glob que usa el pipeline en `lib/config.mjs`: un patrón sin `/` se ancla a
 * cualquier carpeta, `**` cruza carpetas y `*` no. Se repite acá porque esto corre en el
 * navegador y aquel módulo es de Node.
 */
export function globToRegExp(glob: string): RegExp {
	let g = String(glob || '').replace(/\\/g, '/');
	if (!g.includes('/')) g = `**/${g}`;
	let s = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*' && g[i + 1] === '*') {
			if (g[i + 2] === '/') {
				s += '(?:.*/)?';
				i += 2;
			} else {
				s += '.*';
				i += 1;
			}
		} else if (c === '*') s += '[^/]*';
		else if (c === '?') s += '[^/]';
		else if ('+()[]{}|.^$'.includes(c)) s += `\\${c}`;
		else s += c;
	}
	return new RegExp(`^${s}$`);
}

/**
 * Archivos del diff que el modelo no explicó con ningún bloque ni declaró omitidos. El
 * contrato pide que todo archivo caiga en `blocks` o en `skipped`; esto es lo que quedó
 * afuera. `skipped` puede traer globs (`**\/*.Designer.cs`), así que se matchea con glob.
 */
export function uncoveredFiles(doc: ReviewDocument): string[] {
	const files = doc.files ?? [];
	if (!files.length) return [];
	const explained = new Set((doc.blocks ?? []).map((b) => b.file));
	const skipped = (doc.skipped ?? []).map((s) => globToRegExp(s.file));
	return files
		.map((f) => f.path)
		.filter((path) => !explained.has(path) && !skipped.some((re) => re.test(path)))
		.sort((a, b) => a.localeCompare(b));
}
