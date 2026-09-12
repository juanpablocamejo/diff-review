export function groupAnchor(id: string) {
	return `g-${id}`;
}

export function fileAnchor(path: string) {
	return `fl-${path}`;
}

/** Archivo dentro de un tema: el mismo path puede repetirse en varios grupos. */
export function groupFileAnchor(groupId: string, path: string) {
	return `fl-${groupId}-${path}`;
}

export function blockAnchor(id: string) {
	return `bk-${id}`;
}

export function findingAnchor(id: string) {
	return `fd-${id}`;
}

/** Scrollea a un ancla y le da un flash para que se note dónde cayó la vista. */
export function scrollToAnchor(id: string) {
	const el = document.getElementById(id);
	if (!el) return;
	el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	el.classList.remove('anchor-flash');
	// Reinicia la animación aunque se clickee dos veces seguidas.
	void el.offsetWidth;
	el.classList.add('anchor-flash');
	setTimeout(() => el.classList.remove('anchor-flash'), 1400);
}
