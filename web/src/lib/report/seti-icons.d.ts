declare module 'seti-icons' {
	export type SetiTheme = {
		blue: string;
		grey: string;
		'grey-light': string;
		green: string;
		orange: string;
		pink: string;
		purple: string;
		red: string;
		white: string;
		yellow: string;
		ignore: string;
	};

	export type SetiIcon = { svg: string; color: string };

	export function getIcon(fileName: string): SetiIcon;
	export function themeIcons(theme: SetiTheme): (fileName: string) => SetiIcon;
}
