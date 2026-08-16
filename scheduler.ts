export type AutoCompactScope = "total" | "bodyAfterPrefix";

export type TokenStatus = {
	activeContextTokens: number | null;
	contextWindow: number;
	prefillTokens?: number;
};

export function shouldAutoCompact(params: {
	status: TokenStatus;
	limit?: number;
	scope: AutoCompactScope;
	fallbackBufferTokens: number;
}): boolean {
	const { status, limit, scope, fallbackBufferTokens } = params;
	if (status.activeContextTokens === null) return false;
	const scoped = scope === "bodyAfterPrefix" && status.prefillTokens !== undefined
		? Math.max(0, status.activeContextTokens - status.prefillTokens)
		: status.activeContextTokens;
	const configuredLimit = limit === undefined ? Math.floor(status.contextWindow * 0.9) + fallbackBufferTokens : limit + fallbackBufferTokens;
	return scoped >= configuredLimit || status.activeContextTokens >= status.contextWindow;
}
