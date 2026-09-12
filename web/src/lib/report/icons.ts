/**
 * Iconos de archivo Seti (el set clásico de Atom/GitHub): glifo chico + color
 * apagado por extensión. Empaqueta jesseweed/seti-ui vía `seti-icons`.
 */
import { themeIcons } from 'seti-icons';

export type FileIcon = {
	svg: string;
	color: string;
	/** Logo con fills propios: no pintar con currentColor. */
	preserveFill?: boolean;
};

/**
 * Colores de Seti suavizados para que no peleen con el triage ni con el diff.
 * `white` del pack es el default: acá es gris, no blanco literal.
 */
const getSetiIcon = themeIcons({
	blue: '#4c8fd6',
	grey: '#7b8794',
	'grey-light': '#9aa3b2',
	green: '#6aa84f',
	orange: '#d08a3f',
	pink: '#c05a8a',
	purple: '#9b6fc4',
	red: '#c05a5a',
	white: '#8a93a6',
	yellow: '#c9a13b',
	ignore: '#7b8794'
});

/**
 * Extensiones que el pack 0.0.4 no trae (o trae a medias): se reescriben a una
 * extensión vecina que sí tenga glifo, para no caer todos al default genérico.
 * Nota: `.svelte` NO va acá — seti no tiene glifo Svelte; ver CUSTOM_BY_EXT.
 */
const EXT_ALIAS: Record<string, string> = {
	csproj: 'cs',
	props: 'xml',
	targets: 'xml',
	sln: 'cs',
	razor: 'cshtml',
	cts: 'ts',
	mts: 'ts',
	cjs: 'js',
	mjs: 'js',
	jsonc: 'json',
	mdx: 'md'
};

/** Glifos propios cuando el pack no tiene la extensión (p. ej. Svelte). */
const CUSTOM_BY_EXT: Record<string, FileIcon> = {
	// Favicon / logo oficial de https://svelte.dev/svelte-logo.svg (mismos colores).
	svelte: {
		svg: '<svg viewBox="0 0 98.1 118" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet"><path d="m91.8 15.6c-10.9-15.7-32.6-20.3-48.2-10.4l-27.5 17.6c-7.5 4.7-12.7 12.4-14.2 21.1-1.3 7.3-.2 14.8 3.3 21.3-2.4 3.6-4 7.6-4.7 11.8-1.6 8.9.5 18.1 5.7 25.4 11 15.7 32.6 20.3 48.2 10.4l27.5-17.5c7.5-4.7 12.7-12.4 14.2-21.1 1.3-7.3.2-14.8-3.3-21.3 2.4-3.6 4-7.6 4.7-11.8 1.7-9-.4-18.2-5.7-25.5" fill="#ff3e00"/><path d="m40.9 103.9c-8.9 2.3-18.2-1.2-23.4-8.7-3.2-4.4-4.4-9.9-3.5-15.3.2-.9.4-1.7.6-2.6l.5-1.6 1.4 1c3.3 2.4 6.9 4.2 10.8 5.4l1 .3-.1 1c-.1 1.4.3 2.9 1.1 4.1 1.6 2.3 4.4 3.4 7.1 2.7.6-.2 1.2-.4 1.7-.7l27.4-17.5c1.4-.9 2.3-2.2 2.6-3.8s-.1-3.3-1-4.6c-1.6-2.3-4.4-3.3-7.1-2.6-.6.2-1.2.4-1.7.7l-10.5 6.7c-1.7 1.1-3.6 1.9-5.6 2.4-8.9 2.3-18.2-1.2-23.4-8.7-3.1-4.4-4.4-9.9-3.4-15.3.9-5.2 4.1-9.9 8.6-12.7l27.5-17.5c1.7-1.1 3.6-1.9 5.6-2.5 8.9-2.3 18.2 1.2 23.4 8.7 3.2 4.4 4.4 9.9 3.5 15.3-.2.9-.4 1.7-.7 2.6l-.5 1.6-1.4-1c-3.3-2.4-6.9-4.2-10.8-5.4l-1-.3.1-1c.1-1.4-.3-2.9-1.1-4.1-1.6-2.3-4.4-3.3-7.1-2.6-.6.2-1.2.4-1.7.7l-27.4 17.5c-1.4.9-2.3 2.2-2.6 3.8s.1 3.3 1 4.6c1.6 2.3 4.4 3.3 7.1 2.6.6-.2 1.2-.4 1.7-.7l10.5-6.7c1.7-1.1 3.6-1.9 5.6-2.5 8.9-2.3 18.2 1.2 23.4 8.7 3.2 4.4 4.4 9.9 3.5 15.3-.9 5.2-4.1 9.9-8.6 12.7l-27.5 17.5c-1.7 1.1-3.6 1.9-5.6 2.5" fill="#fff"/></svg>',
		color: '#ff3e00',
		preserveFill: true
	}
};

function extensionOf(path: string): string | null {
	const base = path.split(/[/\\]/).pop() ?? path;
	const lower = base.toLowerCase();
	const dot = lower.lastIndexOf('.');
	if (dot < 0) return null;
	return lower.slice(dot + 1);
}

function resolveName(path: string): string {
	const base = path.split(/[/\\]/).pop() ?? path;
	const ext = extensionOf(path);
	if (ext) {
		const alias = EXT_ALIAS[ext];
		if (alias) return `file.${alias}`;
	}
	return base;
}

/** SVG + color Seti (o glifo propio) para un path de archivo. */
export function fileIcon(path: string): FileIcon {
	const ext = extensionOf(path);
	if (ext && CUSTOM_BY_EXT[ext]) return CUSTOM_BY_EXT[ext];
	return getSetiIcon(resolveName(path));
}
