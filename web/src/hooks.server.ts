import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { startPendingAgentRun } from '$lib/server/agent-sessions';

/**
 * Hosts aceptados. La UI escucha en 127.0.0.1 y puede lanzar agentes: un Host ajeno (DNS rebinding: un dominio
 * que resuelve a 127.0.0.1) no debe llegar a la app. Los POST de otro origen ya los frena SvelteKit (CSRF).
 */
function allowedHost(host: string | null): boolean {
	if (!host) return false;
	const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
	if (name === '127.0.0.1' || name === 'localhost' || name === '::1') return true;
	const configured = String(process.env.HOST || '').trim().toLowerCase();
	return Boolean(configured) && configured !== '0.0.0.0' && configured !== '::' && name === configured;
}

/** Si la CLI eligió un agente, la review arranca con el server (el navegador la sigue por `?agent=<id>`). */
export const init: ServerInit = () => {
	startPendingAgentRun();
};

export const handle: Handle = ({ event, resolve }) => {
	if (!allowedHost(event.request.headers.get('host'))) {
		return new Response('Host no permitido', { status: 403 });
	}
	return resolve(event);
};

/** Herramienta local: conviene ver el error real (git, devalue, etc.) y no el 500 genérico. */
export const handleError: HandleServerError = ({ error, message }) => {
	console.error('[diff-review]', error);
	if (error instanceof Error && error.message.trim()) return { message: error.message };
	if (error && typeof error === 'object' && 'message' in error) {
		const detail = String((error as { message?: unknown }).message || '').trim();
		if (detail) return { message: detail };
	}
	return { message: message || 'Error interno' };
};
