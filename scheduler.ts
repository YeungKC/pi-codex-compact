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
}): boolean {
	const { status, limit, scope } = params;
	if (status.activeContextTokens === null) return false;
	const scoped = scope === "bodyAfterPrefix" && status.prefillTokens !== undefined
		? Math.max(0, status.activeContextTokens - status.prefillTokens)
		: status.activeContextTokens;
	const configuredLimit = limit ?? Math.floor(status.contextWindow * 0.9);
	return scoped >= configuredLimit || status.activeContextTokens >= status.contextWindow;
}
