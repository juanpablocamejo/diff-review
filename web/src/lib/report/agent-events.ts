/** Eventos de una sesión con el agente, tal como los ve la web (server → SSE → UI). */

export type ChatMode = 'ask' | 'edit' | 'fix';

export type SessionStatus = 'starting' | 'working' | 'idle' | 'error' | 'closed';

export type AgentEvent =
	| { type: 'status'; status: SessionStatus; message?: string }
	/** Fase visible en la UI en vivo: primero el diff precomputado, después el agente. */
	| { type: 'phase'; phase: 'diff' | 'agent'; detail?: string }
	/** Lo que se le mandó al agente. `review` = el prompt de la review (no se muestra entero). Siempre usa ChatMode (ask/edit/fix). */
	| { type: 'user'; text: string; mode: ChatMode | 'review' }
	/** Texto del agente; los chunks consecutivos se acumulan en el mismo `seq`. */
	| { type: 'text'; kind: 'message' | 'thought'; text: string }
	| { type: 'tool'; id: string; title: string; kind: string; status: string }
	| { type: 'plan'; entries: { content: string; status: string }[] }
	/** Pedido de permiso (política negó). `pending` = espera respuesta del usuario. */
	| {
			type: 'permission';
			requestId: string;
			/** Etiqueta corta del agente (si difiere del comando). */
			title: string;
			kind: string;
			reason: string;
			allow: boolean;
			pending: boolean;
			/** Comando / path real que evalúa la política (p. ej. shell). */
			command?: string;
			/** No mostrar línea individual (p. ej. resuelto en lote → ver `permission_summary`). */
			quiet?: boolean;
		}
	/** Resumen compacto tras aprobar/rechazar varios permisos a la vez. */
	| { type: 'permission_summary'; allow: boolean; count: number }
	/** Resultado de validar el JSON después de un turno que lo escribió. `final` = no habrá otro reintento. */
	| { type: 'review'; ok: boolean; filename: string; errors: string[]; final: boolean }
	| { type: 'turn'; stopReason: string };

export type SeqEvent = AgentEvent & { seq: number };

export type AgentSessionInfo = {
	id: string;
	agentId: string;
	agentLabel: string;
	model: string;
	repo: string;
	branch: string;
	base: string;
	outputFilename: string;
	/** Id de sesión del lado del agente (para `session/load` / meta.agentSession). */
	acpSessionId: string;
	status: SessionStatus;
	busy: boolean;
	/** Último mensaje de status (p. ej. el error que también se imprime en la CLI). */
	statusMessage?: string;
	/** No preguntar permisos denegados por la política en esta sesión. */
	sessionTrust?: boolean;
};

/** Modelos que el agente ofrece por ACP (`currentModel` = su default). `error` si el probe falló. */
export type AcpModels = {
	models: { value: string; name: string }[];
	currentModel: string;
	/** Si vino con fallo: la UI mantiene el fallback y puede reintentar. */
	error?: string;
};

/** Agente con modo ACP instalado, para el select de la web. */
export type AcpAgentOption = {
	id: string;
	label: string;
	path: string;
	models: { value: string; label: string; hint?: string }[];
};

/**
 * Aplica un evento a la lista: un `text` con el mismo `seq` que el último es la continuación de ese chunk.
 */
export function applyEvent(events: SeqEvent[], event: SeqEvent): SeqEvent[] {
	const last = events[events.length - 1];
	if (last && last.seq === event.seq && last.type === 'text' && event.type === 'text') {
		return [...events.slice(0, -1), { ...last, text: last.text + event.text }];
	}
	if (event.type === 'tool') {
		const i = events.findIndex((e) => e.type === 'tool' && e.id === event.id);
		if (i >= 0) {
			const prev = events[i] as Extract<SeqEvent, { type: 'tool' }>;
			const merged = {
				...prev,
				title: event.title || prev.title,
				kind: event.kind || prev.kind,
				status: event.status || prev.status
			};
			return [...events.slice(0, i), merged, ...events.slice(i + 1)];
		}
	}
	if (event.type === 'permission') {
		const i = events.findIndex((e) => e.type === 'permission' && e.requestId === event.requestId);
		if (i >= 0) return [...events.slice(0, i), event, ...events.slice(i + 1)];
	}
	return [...events, event];
}
