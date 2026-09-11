export type Theme = 'dark' | 'light';

const KEY = 'diff-review:theme';

export function loadTheme(): Theme {
	try {
		return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
	} catch {
		return 'dark';
	}
}

export function saveTheme(theme: Theme) {
	try {
		localStorage.setItem(KEY, theme);
	} catch {
		/* localStorage deshabilitado: el tema no persiste, pero la sesión sigue andando */
	}
}

export function applyTheme(theme: Theme) {
	document.documentElement.setAttribute('data-theme', theme);
}
