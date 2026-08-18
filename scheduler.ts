export type AutoCompactScope = "total" | "bodyAfterPrefix";

export type TokenStatus = {
	activeContextTokens: number | null;
	contextWindow: number;
	prefillTokens?: number;
};

export type AutoCompactReason = "automatic" | "downshift";

export function shouldAutoCompact(params: {
	status: TokenStatus;
	limit?: number;
	scope: AutoCompactScope;
	reason?: AutoCompactReason;
}): boolean {
	const { status, limit, scope, reason = "automatic" } = params;
	if (status.activeContextTokens === null) return false;
	if (reason === "downshift") {
		if (scope === "bodyAfterPrefix") return status.activeContextTokens >= status.contextWindow;
		const configuredLimit = limit ?? Math.floor(status.contextWindow * 0.9);
		return status.activeContextTokens > configuredLimit || status.activeContextTokens >= status.contextWindow;
	}
	const scoped = scope === "bodyAfterPrefix"
		? status.prefillTokens === undefined
			? 0
			: Math.max(0, status.activeContextTokens - status.prefillTokens)
		: status.activeContextTokens;
	const configuredLimit = limit ?? Math.floor(status.contextWindow * 0.9);
	return scoped >= configuredLimit || status.activeContextTokens >= status.contextWindow;
}
