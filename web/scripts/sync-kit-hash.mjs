/**
 * Vite 8 + SvelteKit a veces deja el `version_hash` del server distinto del
 * `__sveltekit_*` del client → página en blanco (`Cannot read properties of undefined (reading 'data')`).
 * Alineamos el hash del server al del client después del build.
 *
 * Importante: con overlays de builds viejos en `build/client` puede haber varios
 * `__sveltekit_*`. Tomamos el del entry `start.*.js` que referencia `handler`/`index`
 * (o el start más reciente), no el primer `.js` del walk.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const root = join(import.meta.dirname, '..', 'build');

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

function mtime(p) {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

/** Entry `start.*.js` activo: el que importa el index del adapter, o el más nuevo. */
function activeStartFile() {
	const entryDir = join(root, 'client', '_app', 'immutable', 'entry');
	if (!existsSync(entryDir)) return null;
	const starts = readdirSync(entryDir)
		.filter((n) => /^start\..+\.js$/.test(n) && !n.endsWith('.map'))
		.map((n) => join(entryDir, n));
	if (!starts.length) return null;

	// El HTML/SSR apunta al start del build actual; si hay varios, el más reciente.
	starts.sort((a, b) => mtime(b) - mtime(a));
	return starts[0];
}

/** Hash `__sveltekit_*` del chunk que importa `start.*.js`. */
function clientHashFromStart(startFile) {
	const src = readFileSync(startFile, 'utf8');
	const rel = src.match(/from\s*["'](\.\.\/chunks\/[^"']+)["']/);
	if (rel) {
		const chunk = join(dirname(startFile), rel[1]);
		if (existsSync(chunk)) {
			const m = readFileSync(chunk, 'utf8').match(/__sveltekit_([a-zA-Z0-9]+)/);
			if (m) return { hash: m[1], file: chunk };
		}
	}
	const m = src.match(/__sveltekit_([a-zA-Z0-9]+)/);
	if (m) return { hash: m[1], file: startFile };
	return null;
}

/** `version_hash` del módulo server que carga `handler.js` / `index.js`. */
function activeServerHash() {
	for (const name of ['handler.js', 'index.js']) {
		const entry = join(root, name);
		if (!existsSync(entry)) continue;
		const src = readFileSync(entry, 'utf8');
		const m = src.match(/server\/chunks\/(index\.js-[A-Za-z0-9]+\.js)/);
		if (m) {
			const chunk = join(root, 'server', 'chunks', m[1]);
			if (existsSync(chunk)) {
				const body = readFileSync(chunk, 'utf8');
				const hm = body.match(/version_hash:\s*"([a-zA-Z0-9]+)"/);
				if (hm) return { hash: hm[1], file: chunk, src: body };
			}
		}
	}
	// Fallback: primer version_hash en server (builds sin handler claro).
	for (const f of walk(join(root, 'server'))) {
		if (!f.endsWith('.js')) continue;
		const body = readFileSync(f, 'utf8');
		const hm = body.match(/version_hash:\s*"([a-zA-Z0-9]+)"/);
		if (hm) return { hash: hm[1], file: f, src: body };
	}
	return null;
}

const startFile = activeStartFile();
const client = startFile ? clientHashFromStart(startFile) : null;
const server = activeServerHash();

if (!client?.hash || !server?.hash) {
	console.error(
		'[sync-kit-hash] no encontré hashes (client=%s server=%s)',
		client?.hash || '?',
		server?.hash || '?'
	);
	process.exit(1);
}

if (client.hash === server.hash) {
	console.log(`[sync-kit-hash] ok __sveltekit_${client.hash}`);
	process.exit(0);
}

writeFileSync(server.file, server.src.replace(`version_hash: "${server.hash}"`, `version_hash: "${client.hash}"`));
console.log(`[sync-kit-hash] alineado ${server.hash} → ${client.hash}`);
console.log(`  client: ${client.file}`);
console.log(`  server: ${server.file}`);
