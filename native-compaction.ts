import { createHash } from "node:crypto";
import {
	convertToLlm,
	sessionEntryToContextMessages,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Message, type Model, type Usage } from "@earendil-works/pi-ai";

export const NATIVE_COMPACTION_KIND = "openai-codex-native-compaction";
export const NATIVE_COMPACTION_VERSION = 1;
export const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
export const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const MAX_REMOTE_RETRIES = 2;
export const MAX_RETAINED_AGENT_MESSAGE_TOKENS = 10_000;

const FAIL_CLOSED_ERROR_PATTERN = /(?:malformed|misalignment[_ -]?policy|cyber[_ -]?policy|invalid[_ -]?image|content[ _-]?policy|safety[ _-]?policy|policy[ _-]?violation|unauthorized|forbidden|permission|api[ _-]?key|invalid[ _-]?api[ _-]?key|authentication[ _-]?error|(?:invalid|expired|bearer|refresh)[ _-]?token|cancel(?:led|lation)?|aborted)/i;

export function isFailClosedCompactionError(message: string): boolean {
	return FAIL_CLOSED_ERROR_PATTERN.test(message);
}

export type JsonObject = Record<string, unknown>;
export type ResponseItem = JsonObject & { type?: string };

export interface NativeCompactionDetails {
	kind: typeof NATIVE_COMPACTION_KIND;
	version: typeof NATIVE_COMPACTION_VERSION;
	strategy: "v1" | "v2";
	modelKey: string;
	compHash?: string;
	preservedInput?: ResponseItem[];
	replacementHistory: ResponseItem[];
}

export type NativeCheckpoint = {
	entryIndex: number;
	entryId: string;
	details: NativeCompactionDetails;
};

export type CheckpointLookup =
	| { status: "none" }
	| { status: "invalid"; entryIndex: number; entryId: string }
	| { status: "valid"; checkpoint: NativeCheckpoint };

export type RemoteCompactionResult = {
	strategy: "v2";
	compactionItem: ResponseItem;
	usage?: Usage;
};

export type LegacyCompactionResult = {
	strategy: "v1";
	replacementHistory: ResponseItem[];
	usage?: Usage;
};

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenAICodexModel(model: unknown): model is Model<"openai-codex-responses"> {
	if (!isJsonObject(model)) return false;
	return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function modelKey(model: Pick<Model<any>, "provider" | "api" | "id">): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

function cloneItem<T>(value: T): T {
	return structuredClone(value);
}

function isResponseItem(value: unknown): value is ResponseItem {
	if (!isJsonObject(value)) return false;
	return typeof value.type === "string" || (
		typeof value.role === "string" && (typeof value.content === "string" || Array.isArray(value.content))
	);
}

export function parseNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
	if (!isJsonObject(value)) return undefined;
	if (value.kind !== NATIVE_COMPACTION_KIND || value.version !== NATIVE_COMPACTION_VERSION) return undefined;
	if (typeof value.modelKey !== "string" || !Array.isArray(value.replacementHistory)) return undefined;
	if (value.compHash !== undefined && typeof value.compHash !== "string") return undefined;

	const replacementHistory = value.replacementHistory.filter(isResponseItem);
	if (replacementHistory.length !== value.replacementHistory.length) return undefined;
	const preservedInput = Array.isArray(value.preservedInput) ? value.preservedInput.filter(isResponseItem) : undefined;
	if (value.preservedInput !== undefined && (preservedInput === undefined || preservedInput.length !== value.preservedInput.length)) return undefined;
	const strategy = value.strategy === undefined
		? "v2"
		: value.strategy === "v1" || value.strategy === "v2"
			? value.strategy
			: undefined;
	if (!strategy) return undefined;
	if (strategy === "v2") {
		const compactionItems = replacementHistory.filter((item) => item.type === "compaction");
		if (
			compactionItems.length !== 1 ||
			typeof compactionItems[0]?.encrypted_content !== "string" ||
			replacementHistory.at(-1)?.type !== "compaction"
		) {
			return undefined;
		}
	}

	return {
		kind: NATIVE_COMPACTION_KIND,
		version: NATIVE_COMPACTION_VERSION,
		strategy,
		modelKey: value.modelKey,
		...(typeof value.compHash === "string" ? { compHash: value.compHash } : {}),
		...(preservedInput ? { preservedInput: preservedInput.map(cloneItem) } : {}),
		replacementHistory: replacementHistory.map(cloneItem),
	};
}

export function findNativeCheckpoint(branch: SessionEntry[]): CheckpointLookup {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;

		let rawDetails: unknown;
		if (entry.type === "compaction") {
			if (!isJsonObject(entry.details) || entry.details.kind !== NATIVE_COMPACTION_KIND) {
				return { status: "none" };
			}
			rawDetails = entry.details;
		} else if (entry.type === "custom" && entry.customType === NATIVE_COMPACTION_KIND) {
			rawDetails = entry.data;
		} else {
			continue;
		}

		const details = parseNativeCompactionDetails(rawDetails);
		if (!details) return { status: "invalid", entryIndex: index, entryId: entry.id };
		return {
			status: "valid",
			checkpoint: { entryIndex: index, entryId: entry.id, details },
		};
	}
	return { status: "none" };
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Matches Pi AI's deterministic shortHash for cross-provider Responses item IDs. */
function piShortHash(value: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = (Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)) | 0;
	h2 = (Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)) | 0;
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function normalizedItemId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
	return sanitized.startsWith("fc_") ? sanitized : `fc_${sanitized}`.slice(0, 64);
}

function textSignature(value: unknown): { id?: string; phase?: "commentary" | "final_answer" } {
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed = JSON.parse(value) as JsonObject;
		return {
			id: typeof parsed.id === "string" ? parsed.id : undefined,
			phase: parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined,
		};
	} catch {
		return { id: value };
	}
}

function contentToUserParts(content: unknown): unknown[] {
	if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: unknown[] = [];
	for (const part of content) {
		if (!isJsonObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "input_text", text: part.text });
		} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			parts.push({ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` });
		}
	}
	return parts;
}

function toolResultOutput(message: JsonObject, model: Model<any>): unknown {
	const content = Array.isArray(message.content) ? message.content : [];
	const text = content
		.flatMap((part) => isJsonObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
		.join("\n");
	const images = content.filter((part) => isJsonObject(part) && part.type === "image");
	if (images.length === 0 || !model.input.includes("image")) {
		return text || (images.length > 0 ? "(see attached image)" : "(no tool output)");
	}
	return [
		...(text ? [{ type: "input_text", text }] : []),
		...images.flatMap((part) =>
			typeof part.data === "string" && typeof part.mimeType === "string"
				? [{ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` }]
				: [],
		),
	];
}

function responseTool(tool: ToolInfo, deferLoading = false): JsonObject {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as unknown,
		strict: null,
		...(deferLoading ? { defer_loading: true } : {}),
	};
}

function messagesToResponseItems(model: Model<any>, messages: Message[], tools: ToolInfo[]): ResponseItem[] {
	const items: ResponseItem[] = [];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const pendingToolCalls = new Map<string, string>();
	const flushOrphanedToolCalls = () => {
		for (const callId of pendingToolCalls.values()) {
			items.push({ type: "function_call_output", call_id: callId, output: "No result provided" });
			messageIndex++;
		}
		pendingToolCalls.clear();
	};
	let messageIndex = 0;

	for (const message of messages as unknown as JsonObject[]) {
		const itemCountBefore = items.length;
		if (message.role === "user") {
			flushOrphanedToolCalls();
			const content = contentToUserParts(message.content);
			if (content.length === 0) continue;
			items.push({ role: "user", content });
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			flushOrphanedToolCalls();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const sameModel = message.provider === model.provider
				&& message.api === model.api
				&& message.model === model.id;
			const sameProviderApi = message.provider === model.provider && message.api === model.api;
			let textIndex = 0;
			for (const block of message.content) {
				if (!isJsonObject(block)) continue;
				if (block.type === "thinking") {
					if (!sameModel && block.redacted === true) continue;
					if (sameModel && typeof block.thinkingSignature === "string") {
						try {
							const reasoning = JSON.parse(block.thinkingSignature);
							if (isJsonObject(reasoning) && reasoning.type === "reasoning") items.push(cloneItem(reasoning));
						} catch {}
					} else if (!sameModel && typeof block.thinking === "string" && block.thinking.trim()) {
						const id = textIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textIndex}`;
						textIndex++;
						items.push({
							type: "message",
							role: "assistant",
							id,
							status: "completed",
							phase: undefined,
							content: [{ type: "output_text", text: block.thinking, annotations: [] }],
						});
					}
					continue;
				}
				if (block.type === "text" && typeof block.text === "string") {
					const signature = sameModel ? textSignature(block.textSignature) : {};
					const fallbackId = textIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textIndex}`;
					textIndex++;
					const rawId = signature.id || fallbackId;
					const id = rawId.length <= 64 ? rawId : `msg_${shortHash(rawId)}`;
					items.push({
						type: "message",
						role: "assistant",
						id,
						status: "completed",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
						phase: signature.phase,
					});
					continue;
				}
				if (block.type === "toolCall" && typeof block.id === "string") {
					const [callId, rawItemId] = block.id.split("|");
					pendingToolCalls.set(block.id, callId);
					const itemId = sameProviderApi && !sameModel
						? undefined
						: message.provider !== model.provider || message.api !== model.api
							? (rawItemId ? `fc_${piShortHash(rawItemId)}` : undefined)
							: normalizedItemId(rawItemId);
					items.push({
						type: "function_call",
						call_id: callId,
						id: itemId,
						name: String(block.name ?? ""),
						arguments: JSON.stringify(block.arguments ?? {}),
					});
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const [callId] = message.toolCallId.split("|");
			pendingToolCalls.delete(message.toolCallId);
			items.push({ type: "function_call_output", call_id: callId, output: toolResultOutput(message, model) });

			const addedTools = Array.isArray(message.addedToolNames)
				? message.addedToolNames.flatMap((name) => typeof name === "string" && toolsByName.has(name) ? [toolsByName.get(name)!] : [])
				: [];
			if (addedTools.length > 0) {
				const searchCallId = `pi_tool_load_${piShortHash(`${message.toolCallId}:${addedTools.map((tool) => tool.name).join(",")}`)}`;
				items.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: addedTools.map((tool) => tool.name).join(" "), limit: addedTools.length },
				});
				items.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: addedTools.map((tool) => responseTool(tool, true)),
				});
			}
		}
		if (message.role === "assistant" && items.length === itemCountBefore) continue;
		messageIndex++;
	}
	flushOrphanedToolCalls();

	return items;
}

function entriesToResponseItems(model: Model<any>, entries: SessionEntry[], tools: ToolInfo[], includeCompactionSummary = false): ResponseItem[] {
	const messages = entries
		.filter((entry) => includeCompactionSummary || entry.type !== "compaction")
		.flatMap((entry) => sessionEntryToContextMessages(entry));
	return messagesToResponseItems(model, convertToLlm(messages), tools);
}

export function fullInputForBranch(params: {
	branch: SessionEntry[];
	model: Model<any>;
	tools: ToolInfo[];
}): ResponseItem[] {
	const messages = params.branch
		.filter((entry) => entry.type !== "compaction")
		.flatMap((entry) => sessionEntryToContextMessages(entry));
	return messagesToResponseItems(params.model, convertToLlm(messages), params.tools);
}

/** Reconstructs the context Pi sends after a real CompactionEntry. */
export function systemPromptInputForModel(model: Model<any>, systemPrompt: string): ResponseItem[] {
	if (!systemPrompt) return [];
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
	return [{ role, content: systemPrompt }];
}

export function piContextInputForBranch(params: {
	branch: SessionEntry[];
	model: Model<any>;
	tools: ToolInfo[];
}): ResponseItem[] {
	const checkpoint = findNativeCheckpoint(params.branch);
	const remoteCheckpoint = checkpoint.status === "valid";
	const boundaryEnd = checkpoint.status === "valid" ? checkpoint.checkpoint.entryIndex : params.branch.length;
	let firstKeptEntryId: string | undefined;
	let compactionIndex = -1;
	for (let index = boundaryEnd - 1; index >= 0; index--) {
		const candidate = params.branch[index];
		if (candidate?.type === "compaction" && typeof candidate.firstKeptEntryId === "string") {
			firstKeptEntryId = candidate.firstKeptEntryId;
			compactionIndex = index;
			break;
		}
	}
	if (checkpoint.status === "valid") {
		const entry = params.branch[checkpoint.checkpoint.entryIndex];
		if (entry?.type === "compaction" && typeof entry.firstKeptEntryId === "string") {
			firstKeptEntryId = entry.firstKeptEntryId;
			compactionIndex = checkpoint.checkpoint.entryIndex;
		}
	}
	if (!firstKeptEntryId) return fullInputForBranch(params);
	const firstKeptIndex = params.branch.findIndex((candidate) => candidate.id === firstKeptEntryId);
	if (firstKeptIndex < 0) return fullInputForBranch(params);
	const contextEntries = remoteCheckpoint || compactionIndex < 0
		? params.branch.slice(firstKeptIndex)
		: [
			params.branch[compactionIndex]!,
			...params.branch.slice(firstKeptIndex, compactionIndex),
			...params.branch.slice(compactionIndex + 1),
		];
	return entriesToResponseItems(params.model, contextEntries, params.tools, !remoteCheckpoint);
}

export function effectiveInputForBranch(params: {
	branch: SessionEntry[];
	model: Model<any>;
	tools: ToolInfo[];
	excludeLastAssistantError?: boolean;
	allowCheckpointModelMismatch?: boolean;
}): ResponseItem[] {
	let branch = params.branch;
	if (params.excludeLastAssistantError) {
		const lastAssistantIndex = branch.findLastIndex(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		if (lastAssistantIndex >= 0) {
			branch = branch.filter((_entry, index) => index !== lastAssistantIndex);
		}
	}

	const checkpoint = findNativeCheckpoint(branch);
	if (checkpoint.status === "invalid") {
		throw new Error("The latest OpenAI Codex native compaction checkpoint is malformed.");
	}
	if (checkpoint.status === "valid") {
		if (
			!params.allowCheckpointModelMismatch
			&& checkpoint.checkpoint.details.modelKey !== modelKey(params.model)
		) {
			throw new Error("The latest Codex compaction checkpoint requires model-transition compaction first.");
		}
		const tail = branch.slice(checkpoint.checkpoint.entryIndex + 1);
		return [
			...checkpoint.checkpoint.details.replacementHistory.map(cloneItem),
			...(checkpoint.checkpoint.details.preservedInput ?? []).map(cloneItem),
			...entriesToResponseItems(params.model, tail, params.tools),
		];
	}

	return piContextInputForBranch({ branch, model: params.model, tools: params.tools });
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!isJsonObject(part)) return [];
			if (typeof part.text === "string") return [part.text];
			if (typeof part.encrypted_content === "string") return [part.encrypted_content];
			return [];
		})
		.join("");
}

function textOnly(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOnly).join("");
	if (!isJsonObject(value)) return "";
	if (value.type === "input_image" || value.type === "image_url") return "";
	if (typeof value.text === "string") return value.text;
	if (typeof value.encrypted_content === "string") return value.encrypted_content;
	return Object.values(value).map(textOnly).join("");
}

function responseItemText(item: ResponseItem): string {
	if (item.type === "message" || item.type === "agent_message" || item.type === undefined) {
		return contentText(item.content);
	}
	if (item.type === "function_call_output") {
		if (typeof item.output === "string") return item.output;
		return imagePartCount(item.output) > 0 ? textOnly(item.output) : JSON.stringify(item.output ?? "");
	}
	if (item.type === "function_call") return typeof item.arguments === "string" ? item.arguments : "";
	return "";
}

export function approximateTokenCount(value: unknown): number {
	const encoded = JSON.stringify(value);
	return Math.max(1, Math.ceil((encoded?.length ?? 0) / 4));
}

function imagePartCount(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((total, part) => total + imagePartCount(part), 0);
	if (!isJsonObject(value)) return 0;
	if (value.type === "input_image" || value.type === "image_url") return 1;
	return Object.values(value).reduce((total, part) => total + imagePartCount(part), 0);
}

function approximateTokens(item: ResponseItem): number {
	const imageTokens = imagePartCount(item) * 1_200;
	if (imageTokens > 0) return imageTokens + Math.max(0, Math.ceil(responseItemText(item).length / 4));
	if (item.type === "function_call" || (typeof item.type === "string" && item.type.includes("tool") && item.type !== "function_call_output")) {
		return Math.max(1, Math.ceil(JSON.stringify(item).length / 4));
	}
	return Math.max(1, Math.ceil(responseItemText(item).length / 4));
}

export function approximateResponseItemTokens(items: ResponseItem[]): number {
	return items.reduce((total, item) => total + approximateTokens(item), 0);
}

function truncateFunctionOutput(item: ResponseItem, maxTokens: number): ResponseItem {
	const copy = cloneItem(item);
	if (imagePartCount(copy.output) > 0) {
		copy.output = truncateTextPrefix(textOnly(copy.output), maxTokens * 4);
	} else if (typeof copy.output === "string") {
		copy.output = truncateTextPrefix(copy.output, maxTokens * 4);
	}
	return copy;
}

/** Codex trims old function output before sending an oversized remote request. */
export function trimFunctionCallHistoryToFitContextWindow(
	items: ResponseItem[],
	maxTokens: number,
): ResponseItem[] {
	const result = items.map(cloneItem);
	let excess = approximateResponseItemTokens(result) - maxTokens;
	if (excess <= 0) return result;
	for (const [index, item] of result.entries()) {
		if (excess <= 0) break;
		if (item.type !== "function_call_output") continue;
		const current = approximateTokens(item);
		const kept = Math.max(1, current - excess);
		result[index] = truncateFunctionOutput(item, kept);
		excess -= current - approximateTokens(result[index]!);
	}
	while (excess > 0) {
		const index = result.findIndex((item) => item.type === "function_call_output" && imagePartCount(item) > 0);
		if (index < 0) break;
		result.splice(index, 1);
		excess = approximateResponseItemTokens(result) - maxTokens;
	}
	return result;
}

function truncateTextPrefix(text: string, maxCharacters: number): string {
	return text.slice(0, Math.max(0, maxCharacters));
}

function truncateMessage(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
	if ((item.type !== "message" && item.type !== undefined) || maxTokens <= 0) return undefined;
	const copy = cloneItem(item);
	let remainingCharacters = maxTokens * 4;

	if (typeof copy.content === "string") {
		copy.content = truncateTextPrefix(copy.content, remainingCharacters);
		return copy.content ? copy : undefined;
	}
	if (!Array.isArray(copy.content)) return copy;

	const truncatedContent = copy.content.flatMap((part) => {
		const imageTokens = imagePartCount(part) * 1_200;
		if (imageTokens > 0) {
			if (remainingCharacters < imageTokens * 4) return [];
			remainingCharacters -= imageTokens * 4;
			return [part];
		}
		if (!isJsonObject(part) || typeof part.text !== "string") return [part];
		if (remainingCharacters <= 0) return [];
		const text = truncateTextPrefix(part.text, remainingCharacters);
		remainingCharacters -= text.length;
		return text ? [{ ...part, text }] : [];
	});
	copy.content = truncatedContent;
	return truncatedContent.length > 0 ? copy : undefined;
}

const CONTEXTUAL_USER_WRAPPERS: Array<[string, string]> = [
	["<environment_context>", "</environment_context>"],
	["<environments_instructions>", "</environments_instructions>"],
	["<context_window>", "</context_window>"],
	["<context_window_guidance>", "</context_window_guidance>"],
	["<skills_instructions>", "</skills_instructions>"],
	["<tools>", "</tools>"],
	["<permissions instructions>", "</permissions instructions>"],
	["<model_switch>", "</model_switch>"],
	["<git_attribution>", "</git_attribution>"],
	["<plugins_instructions>", "</plugins_instructions>"],
	["<realtime_conversation>", "</realtime_conversation>"],
	["<personality_spec>", "</personality_spec>"],
	["<rollout_budget>", "</rollout_budget>"],
	["<turn_aborted>", "</turn_aborted>"],
	["<subagent_notification>", "</subagent_notification>"],
	["<user_instructions>", "</user_instructions>"],
	["<user_shell_command>", "</user_shell_command>"],
	["<additional_context>", "</additional_context>"],
];

function isContextualUserText(value: string): boolean {
	const text = value.trimStart();
	const lower = text.toLowerCase();
	if (lower.startsWith("# agents.md instructions")) return lower.trimEnd().endsWith("</instructions>");
	if (lower.startsWith("<codex_internal_context")) {
		return /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>\s*$/.test(text);
	}
	if (lower.startsWith("<goal_context>")) return lower.trimEnd().endsWith("</goal_context>");
	if (lower.startsWith("<skill>")) return lower.trimEnd().endsWith("</skill>");
	if (lower.startsWith("<recommended_plugins>")) return lower.trimEnd().endsWith("</recommended_plugins>");
	if (lower.startsWith("<external_") && lower.includes(">")) {
		const opening = lower.match(/^<(external_[a-z0-9_-]+)>/);
		return opening !== null && lower.trimEnd().endsWith(`</${opening[1]}>`);
	}
	if (lower.startsWith("warning: the maximum number of unified exec processes you can keep open is")) return true;
	if (lower.startsWith("warning: your account was flagged for potentially high-risk cyber activity")) return true;
	if (lower.startsWith("warning: apply_patch was requested via ")) {
		return lower.trimEnd().endsWith("use the apply_patch tool instead of exec_command.");
	}
	return CONTEXTUAL_USER_WRAPPERS.some(([open, close]) =>
		lower.startsWith(open) && lower.trimEnd().endsWith(close),
	);
}

function isHookPromptText(value: string): boolean {
	return /^<hook_prompt\b[^>]*hook_run_id=(?:"[^"]+"|'[^']+')\s*>[\s\S]*<\/hook_prompt>\s*$/i.test(value.trim());
}

function isRetainedUserMessage(item: ResponseItem): boolean {
	if (typeof item.content === "string") return !isContextualUserText(item.content);
	if (!Array.isArray(item.content)) return true;
	let hookPrompt = false;
	let onlyContextOrHook = true;
	for (const part of item.content) {
		if (!isJsonObject(part) || typeof part.text !== "string") {
			onlyContextOrHook = false;
			continue;
		}
		if (isHookPromptText(part.text)) {
			hookPrompt = true;
			continue;
		}
		if (isContextualUserText(part.text)) continue;
		onlyContextOrHook = false;
	}
	return hookPrompt ? onlyContextOrHook : !item.content.some(
		(part) => isJsonObject(part) && typeof part.text === "string" && isContextualUserText(part.text),
	);
}

function isFinalAnswerAgentMessage(item: ResponseItem): boolean {
	if (item.type !== "agent_message" || !Array.isArray(item.content)) return false;
	const first = item.content[0];
	return isJsonObject(first)
		&& first.type === "input_text"
		&& typeof first.text === "string"
		&& first.text.startsWith("Message Type: FINAL_ANSWER\n");
}

function retainedByCodex(item: ResponseItem): boolean {
	if (item.type === "agent_message") {
		return !isFinalAnswerAgentMessage(item) && approximateTokens(item) <= MAX_RETAINED_AGENT_MESSAGE_TOKENS;
	}
	if (item.type !== "message" && item.type !== undefined) return false;
	return item.role === "user" && isRetainedUserMessage(item);
}

/** Mirrors current Codex V2's retained message whitelist and 64k newest-first budget. */
export function retainRecentMessages(items: ResponseItem[], maxTokens = RETAINED_MESSAGE_TOKEN_BUDGET): ResponseItem[] {
	let remaining = maxTokens;
	const retained: ResponseItem[] = [];
	for (const item of [...items].reverse()) {
		if (remaining <= 0 || !retainedByCodex(item)) continue;
		const tokens = approximateTokens(item);
		if (tokens <= remaining) {
			retained.push(cloneItem(item));
			remaining -= tokens;
			continue;
		}
		const truncated = (item.type === "message" || item.type === undefined)
			? truncateMessage(item, remaining)
			: undefined;
		if (truncated) remaining = 0;
		if (truncated) retained.push(truncated);
	}
	return retained.reverse();
}

export function filterLegacyCompactionHistory(items: ResponseItem[]): ResponseItem[] {
	return items.filter((item) => {
		if (item.type === "message" || item.type === undefined) {
			if (item.role === "assistant") return true;
			return item.role === "user" && isRetainedUserMessage(item);
		}
		return item.type === "compaction" || item.type === "context_compaction" || item.type === "agent_message";
	});
}

export function buildReplacementHistory(
	preCompactionInput: ResponseItem[],
	compactionItem: ResponseItem,
): ResponseItem[] {
	if (compactionItem.type !== "compaction" || typeof compactionItem.encrypted_content !== "string") {
		throw new Error("OpenAI Codex did not return a valid compaction item.");
	}
	return [...retainRecentMessages(preCompactionInput), cloneItem(compactionItem)];
}

export function buildToolPayload(allTools: ToolInfo[], activeToolNames: string[]): unknown[] | undefined {
	const active = new Set(activeToolNames);
	const tools = allTools.filter((tool) => active.has(tool.name));
	return tools.length > 0 ? tools.map((tool) => responseTool(tool)) : undefined;
}

export function buildCompactionRequestBody(params: {
	basePayload?: JsonObject;
	model: Model<any>;
	input: ResponseItem[];
	instructions: string;
	tools?: unknown[];
	sessionId: string;
}): JsonObject {
	const base = params.basePayload ? cloneItem(params.basePayload) : {};
	const previousText = isJsonObject(base.text) ? base.text : undefined;
	const include = Array.isArray(base.include)
		? [...new Set([...base.include.filter((value): value is string => typeof value === "string"), "reasoning.encrypted_content"])]
		: ["reasoning.encrypted_content"];

	const body: JsonObject = {
		...base,
		model: params.model.id,
		store: false,
		stream: true,
		instructions: params.instructions,
		input: [...params.input.map(cloneItem), { type: "compaction_trigger" }],
		tool_choice: "auto",
		parallel_tool_calls: true,
		include,
		prompt_cache_key: params.sessionId,
		text: previousText && typeof previousText.verbosity === "string"
			? { verbosity: previousText.verbosity }
			: { verbosity: "low" },
	};
	if (params.tools) body.tools = params.tools;
	else delete body.tools;
	delete body.messages;
	delete body.previous_response_id;
	return body;
}

export function resolveCodexResponsesUrl(baseUrl?: string): string {
	const normalized = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function extractCodexAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JsonObject;
		const auth = payload["https://api.openai.com/auth"];
		if (!isJsonObject(auth) || typeof auth.chatgpt_account_id !== "string") throw new Error("Missing account ID");
		return auth.chatgpt_account_id;
	} catch {
		throw new Error("Failed to extract the ChatGPT account ID from the OpenAI Codex token.");
	}
}

export function mergeFeatureHeader(existing: string | null | undefined): string {
	const features = (existing ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set([...features, REMOTE_COMPACTION_FEATURE])].join(",");
}

export function buildCodexHeaders(params: {
	apiKey: string;
	headers?: Record<string, string>;
	sessionId: string;
	includeRemoteCompactionV2?: boolean;
}): Headers {
	const headers = new Headers(params.headers);
	headers.set("authorization", `Bearer ${params.apiKey}`);
	headers.set("chatgpt-account-id", extractCodexAccountId(params.apiKey));
	headers.set("originator", "pi");
	headers.set("user-agent", "pi-codex-compact");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	headers.set("session-id", params.sessionId);
	headers.set("x-client-request-id", params.sessionId);
	if (params.includeRemoteCompactionV2 !== false) {
		headers.set("x-codex-beta-features", mergeFeatureHeader(headers.get("x-codex-beta-features")));
	}
	return headers;
}

function parseRetryDelay(response: Response): number | undefined {
	const milliseconds = Number(response.headers.get("retry-after-ms"));
	if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
	const retryAfter = response.headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function canFallbackForStatus(status: number, body: string): boolean {
	if (![400, 403, 404, 408, 409, 429].includes(status) && status < 500) return false;
	if (status === 403 && !/(?:model|invalid request|not found|overloaded)/i.test(body)) return false;
	if (status === 404 && !/(?:model|invalid request|overloaded)/i.test(body)) return false;
	return !isFailClosedCompactionError(body);
}

function markFallbackEligibility(error: Error, eligible: boolean): Error & { retryWithCurrentModel: boolean } {
	Object.defineProperty(error, "retryWithCurrentModel", { value: eligible, enumerable: false });
	return error as Error & { retryWithCurrentModel: boolean };
}

class NonRetryableCompactionError extends Error {}
class RetryableCompactionStreamError extends Error {}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Compaction aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function parseSseResponse(response: Response): Promise<{ item: ResponseItem; usage?: unknown }> {
	if (!response.body) throw new Error("OpenAI Codex returned an empty compaction stream.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let completed = false;
	let usage: unknown;
	const compactionItems: ResponseItem[] = [];

	const processBlock = (block: string) => {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") return;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			throw new NonRetryableCompactionError("OpenAI Codex returned malformed compaction SSE data.");
		}
		if (!isJsonObject(event)) return;
		if (event.type === "error") {
			const code = typeof event.code === "string" ? event.code : "";
			if (typeof event.message !== "string" || !event.message.trim()) {
				throw new RetryableCompactionStreamError("OpenAI Codex compaction failed.");
			}
			const error = new NonRetryableCompactionError(event.message);
			throw code && isFailClosedCompactionError(code)
				? markFallbackEligibility(error, false)
				: error;
		}
		if (event.type === "response.failed") {
			const response = isJsonObject(event.response) ? event.response : {};
			const failure = isJsonObject(response.error) ? response.error : {};
			const code = typeof failure.code === "string" ? failure.code : "response.failed";
			const rawMessage = typeof failure.message === "string" ? failure.message : undefined;
			const message = rawMessage ?? "OpenAI Codex compaction ended with response.failed.";
			const eligible = rawMessage !== undefined && rawMessage.trim().length > 0
				&& (code === "context_length_exceeded" || code === "invalid_prompt")
				&& !isFailClosedCompactionError(message);
			throw markFallbackEligibility(new NonRetryableCompactionError(`OpenAI Codex compaction failed (${code}): ${message}`), eligible);
		}
		if (event.type === "response.incomplete") {
			throw new RetryableCompactionStreamError("OpenAI Codex compaction ended with response.incomplete.");
		}
		if (event.type === "response.output_item.done" && isResponseItem(event.item) && event.item.type === "compaction") {
			compactionItems.push(event.item);
		}
		if (event.type === "response.completed" || event.type === "response.done") {
			completed = true;
			usage = isJsonObject(event.response) ? event.response.usage : undefined;
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		buffer = buffer.replace(/\r\n/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			processBlock(buffer.slice(0, boundary));
			buffer = buffer.slice(boundary + 2);
			boundary = buffer.indexOf("\n\n");
		}
		if (done) break;
	}
	if (buffer.trim()) processBlock(buffer);
	if (!completed) {
		throw new RetryableCompactionStreamError(
			"OpenAI Codex compaction stream closed before response.completed.",
		);
	}
	if (compactionItems.length !== 1) {
		throw new NonRetryableCompactionError(
			`OpenAI Codex returned ${compactionItems.length} compaction items; expected exactly one.`,
		);
	}
	const item = compactionItems[0]!;
	if (typeof item.encrypted_content !== "string") {
		throw new NonRetryableCompactionError(
			"OpenAI Codex returned a compaction item without encrypted_content.",
		);
	}
	return { item, usage };
}

function usageFromResponse(model: Model<any>, value: unknown): Usage | undefined {
	if (!isJsonObject(value)) return undefined;
	const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
	const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;
	const details = isJsonObject(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const cacheRead = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
	const cacheWrite = typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
	const usage: Usage = {
		input: Math.max(0, inputTokens - cacheRead - cacheWrite),
		output: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

export async function callRemoteCompaction(params: {
	url: string;
	headers: Headers;
	body: JsonObject;
	model: Model<any>;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<RemoteCompactionResult> {
	const fetchImpl = params.fetchImpl ?? fetch;
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_REMOTE_RETRIES; attempt++) {
		try {
			const response = await fetchImpl(params.url, {
				method: "POST",
				headers: params.headers,
				body: JSON.stringify(params.body),
				signal: params.signal,
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				const message = `OpenAI Codex compaction failed (${response.status}): ${body || response.statusText}`;
				if (!isRetryableStatus(response.status)) throw markFallbackEligibility(new NonRetryableCompactionError(message), canFallbackForStatus(response.status, body));
				const error = markFallbackEligibility(new Error(message), canFallbackForStatus(response.status, body));
				if (attempt === MAX_REMOTE_RETRIES) throw error;
				lastError = error;
				await delay(parseRetryDelay(response) ?? 1000 * 2 ** attempt, params.signal);
				continue;
			}
			const parsed = await parseSseResponse(response);
			return { strategy: "v2", compactionItem: parsed.item, usage: usageFromResponse(params.model, parsed.usage) };
		} catch (error) {
			if (params.signal?.aborted || error instanceof NonRetryableCompactionError) throw error;
			lastError = error;
			if (attempt === MAX_REMOTE_RETRIES) throw error;
			await delay(1000 * 2 ** attempt, params.signal);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("OpenAI Codex compaction failed.");
}

export function buildLegacyCompactionRequestBody(params: {
	basePayload?: JsonObject;
	model: Model<any>;
	input: ResponseItem[];
	instructions: string;
	tools?: unknown[];
	sessionId: string;
}): JsonObject {
	const base = params.basePayload ? cloneItem(params.basePayload) : {};
	const body: JsonObject = {
		...base,
		model: params.model.id,
		input: params.input.map(cloneItem),
		instructions: params.instructions,
		parallel_tool_calls: true,
		prompt_cache_key: params.sessionId,
	};
	if (params.tools) body.tools = params.tools;
	else delete body.tools;
	delete body.messages;
	delete body.previous_response_id;
	delete body.stream;
	delete body.store;
	delete body.include;
	delete body.tool_choice;
	return body;
}

export function resolveCodexCompactUrl(baseUrl?: string): string {
	return `${resolveCodexResponsesUrl(baseUrl)}/compact`;
}

export async function callLegacyRemoteCompaction(params: {
	url: string;
	headers: Headers;
	body: JsonObject;
	model: Model<any>;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<LegacyCompactionResult> {
	const fetchImpl = params.fetchImpl ?? fetch;
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_REMOTE_RETRIES; attempt++) {
		try {
			const response = await fetchImpl(params.url, {
				method: "POST",
				headers: params.headers,
				body: JSON.stringify(params.body),
				signal: params.signal,
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				const eligible = canFallbackForStatus(response.status, body);
				const error = markFallbackEligibility(
					isRetryableStatus(response.status)
						? new Error(`OpenAI Codex legacy compaction failed (${response.status}): ${body || response.statusText}`)
						: new NonRetryableCompactionError(`OpenAI Codex legacy compaction failed (${response.status}): ${body || response.statusText}`),
					eligible,
				);
				if (!isRetryableStatus(response.status) || attempt === MAX_REMOTE_RETRIES) throw error;
				lastError = error;
				await delay(1000 * 2 ** attempt, params.signal);
				continue;
			}
			const parsed = await response.json() as JsonObject;
			if (!Array.isArray(parsed.output) || parsed.output.some((item) => !isResponseItem(item))) {
				throw new NonRetryableCompactionError("OpenAI Codex legacy compaction returned invalid output.");
			}
			return {
				strategy: "v1",
				replacementHistory: parsed.output.map(cloneItem),
				usage: usageFromResponse(params.model, parsed.usage),
			};
		} catch (error) {
			if (params.signal?.aborted || error instanceof NonRetryableCompactionError || attempt === MAX_REMOTE_RETRIES) throw error;
			lastError = error;
			await delay(1000 * 2 ** attempt, params.signal);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("OpenAI Codex legacy compaction failed.");
}

export function stripInputFromPayload(payload: JsonObject): JsonObject {
	const shape = cloneItem(payload);
	delete shape.input;
	delete shape.messages;
	delete shape.previous_response_id;
	return shape;
}
