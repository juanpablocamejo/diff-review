import type { FileNavItem } from './build';

/** Hallazgos de un archivo y cuántos ya tienen decisión tomada. */
export type FileCount = { total: number; done: number };

export type TreeRow =
	| {
			kind: 'dir';
			/** Path completo de la carpeta: sirve de clave y de estado de plegado. */
			key: string;
			depth: number;
			label: string;
			files: number;
			findings: number;
			/** Todos los hallazgos que cuelgan de la carpeta ya tienen decisión. */
			done: boolean;
			open: boolean;
	  }
	| {
			kind: 'file';
			key: string;
			depth: number;
			label: string;
			path: string;
			changeMark: string;
			navigable: boolean;
			findings: number;
			done: boolean;
			skipReasonLabel?: string;
	  };

type Node = {
	name: string;
	path: string;
	dirs: Map<string, Node>;
	files: FileNavItem[];
	fileCount: number;
	findingCount: number;
	doneCount: number;
};

function emptyNode(name: string, path: string): Node {
	return { name, path, dirs: new Map(), files: [], fileCount: 0, findingCount: 0, doneCount: 0 };
}

/**
 * Fusiona carpetas con un solo hijo carpeta y nada más: en un monorepo, media pantalla se
 * va en `apps` › `back-product` › `src` › … sin que ninguno de esos niveles diga nada.
 */
function compress(node: Node) {
	for (const [key, child] of node.dirs) {
		compress(child);
		if (child.dirs.size === 1 && child.files.length === 0) {
			const only = [...child.dirs.values()][0];
			node.dirs.delete(key);
			node.dirs.set(only.path, { ...only, name: `${child.name}/${only.name}` });
		}
	}
}

function tally(node: Node, counts: Map<string, FileCount>): { files: number; findings: number; done: number } {
	let files = node.files.length;
	let findings = 0;
	let done = 0;
	for (const file of node.files) {
		const count = counts.get(file.path);
		findings += count?.total ?? 0;
		done += count?.done ?? 0;
	}
	for (const child of node.dirs.values()) {
		const sub = tally(child, counts);
		files += sub.files;
		findings += sub.findings;
		done += sub.done;
	}
	node.fileCount = files;
	node.findingCount = findings;
	node.doneCount = done;
	return { files, findings, done };
}

/** Arma el bosque comprimido a partir de los paths (misma lógica que el render). */
function buildForest(items: FileNavItem[]): Node {
	const root = emptyNode('', '');
	for (const item of items) {
		const parts = item.path.split('/');
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const path = parts.slice(0, i + 1).join('/');
			let child = node.dirs.get(path);
			if (!child) {
				child = emptyNode(parts[i], path);
				node.dirs.set(path, child);
			}
			node = child;
		}
		node.files.push(item);
	}
	compress(root);
	return root;
}

/** Paths de todas las carpetas del árbol (post-compress), para expandir/colapsar todo. */
export function collectTreeDirPaths(items: FileNavItem[]): string[] {
	const paths: string[] = [];
	const walk = (node: Node) => {
		for (const dir of node.dirs.values()) {
			paths.push(dir.path);
			walk(dir);
		}
	};
	walk(buildForest(items));
	return paths;
}

/**
 * Arma las filas visibles del árbol: carpetas primero y archivos después, en orden
 * alfabético, saltando lo que cuelga de una carpeta plegada. Devuelve una lista plana
 * porque así se renderiza con un `each` y la indentación es un padding, sin recursión.
 */
export function buildTreeRows(
	items: FileNavItem[],
	counts: Map<string, FileCount>,
	collapsed: Set<string>
): TreeRow[] {
	const root = buildForest(items);
	tally(root, counts);

	const rows: TreeRow[] = [];
	const walk = (node: Node, depth: number) => {
		const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
		for (const dir of dirs) {
			const open = !collapsed.has(dir.path);
			rows.push({
				kind: 'dir',
				key: dir.path,
				depth,
				label: dir.name,
				files: dir.fileCount,
				findings: dir.findingCount,
				done: dir.findingCount > 0 && dir.doneCount === dir.findingCount,
				open
			});
			if (open) walk(dir, depth + 1);
		}
		for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
			const count = counts.get(file.path);
			rows.push({
				kind: 'file',
				key: file.path,
				depth,
				label: file.path.split('/').pop() ?? file.path,
				path: file.path,
				changeMark: file.changeMark,
				navigable: file.navigable,
				findings: count?.total ?? 0,
				done: !!count?.total && count.done === count.total,
				skipReasonLabel: file.skipReasonLabel
			});
		}
	};
	walk(root, 0);
	return rows;
}
