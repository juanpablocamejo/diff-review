import { error } from '@sveltejs/kit';
import { sessionInfo, subscribe } from '$lib/server/agent-sessions';
import type { RequestHandler } from './$types';

/** Eventos de una sesión con el agente (SSE). Al conectar manda `reset` y todo lo acumulado; después, lo nuevo. */
export const GET: RequestHandler = ({ params, request }) => {
	if (!sessionInfo(params.id)) error(404, 'La sesión del agente ya no existe.');
	let unsubscribe: (() => void) | null = null;
	let ping: ReturnType<typeof setInterval> | null = null;
	const encoder = new TextEncoder();

	const cleanup = () => {
		unsubscribe?.();
		unsubscribe = null;
		if (ping) clearInterval(ping);
		ping = null;
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					cleanup();
				}
			};
			unsubscribe = subscribe(params.id, send);
			if (!unsubscribe) {
				controller.close();
				return;
			}
			// Comentario SSE para que proxies y el navegador no corten la conexión ociosa.
			ping = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch {
					cleanup();
				}
			}, 20_000);
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* ya cerrado */
				}
			});
		},
		cancel: cleanup
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
