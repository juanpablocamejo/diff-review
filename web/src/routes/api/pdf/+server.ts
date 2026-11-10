import { error } from '@sveltejs/kit';
import { findBrowser, renderPdf } from '$lib/server/pdf';
import type { RequestHandler } from './$types';

/** Límite del HTML recibido (los reportes rondan los cientos de KB). */
const MAX_BYTES = 20 * 1024 * 1024;

/** Recibe el HTML del export y devuelve el PDF impreso por Chrome/Edge headless. */
export const POST: RequestHandler = async ({ request }) => {
	if (!findBrowser()) error(501, 'No hay un navegador compatible para generar el PDF.');
	const html = await request.text();
	if (!html.trim()) error(400, 'Falta el HTML.');
	if (html.length > MAX_BYTES) error(413, 'El reporte es demasiado grande.');
	try {
		const pdf = await renderPdf(html);
		return new Response(new Uint8Array(pdf), {
			headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' }
		});
	} catch (e) {
		error(500, e instanceof Error ? e.message : 'No se pudo generar el PDF.');
	}
};
