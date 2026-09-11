import type { HandleServerError } from '@sveltejs/kit';

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
