/**
 * Iconos de archivo Seti (el set clásico de Atom/GitHub): glifo chico + color
 * apagado por extensión. Empaqueta jesseweed/seti-ui vía `seti-icons`.
 */
import { themeIcons } from 'seti-icons';

export type FileIcon = {
	svg: string;
	color: string;
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
 */
const EXT_ALIAS: Record<string, string> = {
	svelte: 'vue',
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

function resolveName(path: string): string {
	const base = path.split('/').pop() ?? path;
	const lower = base.toLowerCase();
	const dot = lower.lastIndexOf('.');
	if (dot < 0) return base;
	const alias = EXT_ALIAS[lower.slice(dot + 1)];
	return alias ? `file.${alias}` : base;
}

/** SVG + color Seti para un path de archivo. */
export function fileIcon(path: string): FileIcon {
	return getSetiIcon(resolveName(path));
}
