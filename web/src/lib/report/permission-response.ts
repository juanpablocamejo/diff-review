export type PermissionScope = 'once' | 'session' | 'always';

export type PermissionResponse = {
	requestId?: string;
	allow: boolean;
	allowAll?: boolean;
	/** once (default) | session | always (ACP allow_always). */
	scope?: PermissionScope;
};
