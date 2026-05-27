// deprecated: https://api-docs.deepseek.com/quick_start/agent_integrations/copilot_cli

import { createError, defineEventHandler, getRequestHeaders, getRequestURL, readRawBody } from 'h3';

/**
 * OpenAI-compatible DeepSeek chat-completions proxy.
 *
 * Copilot SDK owns its internal tool-call loop and request history. DeepSeek V4
 * thinking mode requires assistant messages with tool_calls to be replayed with
 * their original reasoning_content, but the SDK/CLI currently drops that raw
 * provider field in later tool-call requests. This proxy preserves streamed
 * reasoning_content by tool_call.id and injects it back into later requests
 * before forwarding them to DeepSeek.
 */

type JsonObject = Record<string, unknown>;

interface DeepSeekToolCall {
	id?: string;
	index?: number;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

interface DeepSeekMessage extends JsonObject {
	role?: string;
	content?: unknown;
	tool_calls?: DeepSeekToolCall[];
	reasoning_content?: unknown;
}

interface DeepSeekChatRequest extends JsonObject {
	model?: string;
	messages?: DeepSeekMessage[];
	stream?: boolean;
	thinking?: { type?: 'enabled' | 'disabled' };
	reasoning_effort?: string;
	reasoningEffort?: string;
}

interface DeepSeekChoice {
	delta?: {
		reasoning_content?: string;
		tool_calls?: DeepSeekToolCall[];
	};
	message?: {
		reasoning_content?: string;
		tool_calls?: DeepSeekToolCall[];
	};
	finish_reason?: string | null;
}

interface DeepSeekStreamChunk {
	choices?: DeepSeekChoice[];
}

interface ReasoningRecord {
	reasoningContent: string;
	createdAt: number;
	toolCallIds: string[];
}

const DEEPSEEK_API_BASE_URL = process.env.DEEPSEEK_PROXY_TARGET_BASE_URL || 'https://api.deepseek.com';
const REASONING_CACHE_TTL_MS = 30 * 60 * 1000;
const REASONING_CACHE_MAX_ENTRIES = 1_000;

// Process-local cache is enough for the Copilot SDK session loop, which sends
// the tool-call follow-up requests through the same Nuxt server process.
const reasoningByToolCallId = new Map<string, ReasoningRecord>();

export default defineEventHandler(async (event) => {
	const rawBody = await readRawBody(event, 'utf8');
	if (!rawBody) {
		throw createError({ statusCode: 400, statusMessage: 'Missing request body' });
	}

	const request = parseJsonBody(rawBody);
	normalizeDeepSeekThinking(request);
	const patchedCount = patchMissingReasoningContent(request);

	if (patchedCount > 0) {
		const url = getRequestURL(event);
		console.info(
			`[deepseek-proxy] replayed reasoning_content for ${patchedCount} assistant message(s)`
			+ ` path=${url.pathname}`
			+ ` model=${request.model ?? 'unknown'}`,
		);
	}

	const upstream = await fetch(`${stripTrailingSlash(DEEPSEEK_API_BASE_URL)}/chat/completions`, {
		method: 'POST',
		headers: buildForwardHeaders(getRequestHeaders(event)),
		body: JSON.stringify(request),
	});

	const headers = buildResponseHeaders(upstream.headers);

	if (!upstream.ok) {
		const errorBody = await upstream.text();
		console.warn(`[deepseek-proxy] upstream error status=${upstream.status} body=${errorBody.slice(0, 500)}`);
		return new Response(errorBody, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	if (!upstream.body) {
		return new Response(null, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	if (isStreamingResponse(request, upstream.headers)) {
		return new Response(createReasoningCaptureStream(upstream.body), {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	const responseJson = await upstream.json() as DeepSeekStreamChunk;
	captureReasoningFromChoice(responseJson.choices?.[0]);

	headers.set('content-type', 'application/json');
	return new Response(JSON.stringify(responseJson), {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
});

function parseJsonBody(rawBody: string): DeepSeekChatRequest {
	try {
		const parsed = JSON.parse(rawBody) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Request body must be a JSON object');
		}
		return parsed as DeepSeekChatRequest;
	} catch (error) {
		throw createError({
			statusCode: 400,
			statusMessage: error instanceof Error ? error.message : 'Invalid JSON request body',
		});
	}
}

function normalizeDeepSeekThinking(request: DeepSeekChatRequest): void {
	const camelEffort = typeof request.reasoningEffort === 'string'
		? request.reasoningEffort.trim()
		: undefined;
	const snakeEffort = typeof request.reasoning_effort === 'string'
		? request.reasoning_effort.trim()
		: undefined;
	const reasoningEffort = snakeEffort || camelEffort;

	delete request.reasoningEffort;

	if (!reasoningEffort) return;

	// The app may send provider-agnostic custom strings. Translate the common
	// off values into DeepSeek's explicit thinking-disable body shape.
	if (reasoningEffort === 'none' || reasoningEffort === 'disabled' || reasoningEffort === 'off') {
		delete request.reasoning_effort;
		request.thinking = { type: 'disabled' };
		return;
	}

	request.reasoning_effort = reasoningEffort;
	request.thinking = { type: 'enabled' };
}

function patchMissingReasoningContent(request: DeepSeekChatRequest): number {
	cleanupReasoningCache();

	if (!Array.isArray(request.messages)) return 0;

	let patchedCount = 0;
	request.messages = request.messages.map((message) => {
		if (!shouldPatchMessage(message)) return message;

		const record = findReasoningRecord(message.tool_calls ?? []);
		if (!record) return message;

		patchedCount += 1;
		return {
			...message,
			reasoning_content: record.reasoningContent,
		};
	});

	return patchedCount;
}

function shouldPatchMessage(message: DeepSeekMessage): boolean {
	// DeepSeek rejects thinking-mode histories when assistant tool-call messages
	// are replayed without the reasoning_content that produced those calls.
	return message.role === 'assistant'
		&& Array.isArray(message.tool_calls)
		&& message.tool_calls.length > 0
		&& (typeof message.reasoning_content !== 'string' || message.reasoning_content.length === 0);
}

function findReasoningRecord(toolCalls: DeepSeekToolCall[]): ReasoningRecord | undefined {
	for (const toolCall of toolCalls) {
		if (!toolCall.id) continue;
		const record = reasoningByToolCallId.get(toolCall.id);
		if (record?.reasoningContent) return record;
	}
}

function createReasoningCaptureStream(upstreamBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let buffer = '';
	let reasoningContent = '';
	const toolCallIds = new Set<string>();

	const captureLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') return;

		try {
			const chunk = JSON.parse(trimmed.slice(6)) as DeepSeekStreamChunk;
			const choice = chunk.choices?.[0];
			const delta = choice?.delta;

			if (delta?.reasoning_content) {
				reasoningContent += delta.reasoning_content;
			}

			collectToolCallIds(delta?.tool_calls, toolCallIds);

			// Once DeepSeek finishes a tool-call response, bind all emitted tool
			// call ids to the accumulated thinking text so follow-up requests can
			// reconstruct assistant.reasoning_content.
			if (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'stop') {
				storeReasoningForToolCalls(reasoningContent, [...toolCallIds]);
			}
		} catch {
			// Preserve upstream bytes even if a diagnostic chunk is not valid JSON.
		}
	};

	const flushBuffer = (): void => {
		if (!buffer) return;
		captureLine(buffer);
		buffer = '';
	};

	return upstreamBody.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			controller.enqueue(chunk);

			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				captureLine(line);
			}
		},
		flush() {
			buffer += decoder.decode();
			flushBuffer();
			storeReasoningForToolCalls(reasoningContent, [...toolCallIds]);
		},
	}));
}

function captureReasoningFromChoice(choice: DeepSeekChoice | undefined): void {
	const reasoningContent = choice?.message?.reasoning_content || choice?.delta?.reasoning_content || '';
	const toolCallIds = new Set<string>();

	collectToolCallIds(choice?.message?.tool_calls, toolCallIds);
	collectToolCallIds(choice?.delta?.tool_calls, toolCallIds);
	storeReasoningForToolCalls(reasoningContent, [...toolCallIds]);
}

function collectToolCallIds(toolCalls: DeepSeekToolCall[] | undefined, ids: Set<string>): void {
	if (!Array.isArray(toolCalls)) return;
	for (const toolCall of toolCalls) {
		if (toolCall.id) ids.add(toolCall.id);
	}
}

function storeReasoningForToolCalls(reasoningContent: string, toolCallIds: string[]): void {
	if (!reasoningContent || toolCallIds.length === 0) return;

	const record: ReasoningRecord = {
		reasoningContent,
		toolCallIds,
		createdAt: Date.now(),
	};

	for (const toolCallId of toolCallIds) {
		reasoningByToolCallId.set(toolCallId, record);
	}
}

function cleanupReasoningCache(): void {
	const now = Date.now();
	for (const [toolCallId, record] of reasoningByToolCallId) {
		if (now - record.createdAt > REASONING_CACHE_TTL_MS) {
			reasoningByToolCallId.delete(toolCallId);
		}
	}

	while (reasoningByToolCallId.size > REASONING_CACHE_MAX_ENTRIES) {
		const oldestKey = reasoningByToolCallId.keys().next().value;
		if (!oldestKey) break;
		reasoningByToolCallId.delete(oldestKey);
	}
}

function buildForwardHeaders(requestHeaders: Record<string, string | string[] | undefined>): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(requestHeaders)) {
		if (!value || isHopByHopHeader(name)) continue;
		headers.set(name, Array.isArray(value) ? value.join(', ') : value);
	}

	if (!headers.has('authorization') && process.env.DEEPSEEK_API_KEY) {
		headers.set('authorization', `Bearer ${process.env.DEEPSEEK_API_KEY}`);
	}

	headers.set('content-type', 'application/json');
	headers.set('accept', 'text/event-stream, application/json');
	return headers;
}

function buildResponseHeaders(upstreamHeaders: Headers): Headers {
	const headers = new Headers();
	upstreamHeaders.forEach((value, name) => {
		if (!isHopByHopHeader(name) && name !== 'content-encoding' && name !== 'content-length') {
			headers.set(name, value);
		}
	});
	headers.set('cache-control', 'no-cache');
	headers.set('x-accel-buffering', 'no');
	return headers;
}

function isStreamingResponse(request: DeepSeekChatRequest, headers: Headers): boolean {
	return request.stream === true || (headers.get('content-type') ?? '').includes('text/event-stream');
}

function isHopByHopHeader(name: string): boolean {
	return [
		'connection',
		'content-length',
		'host',
		'keep-alive',
		'proxy-authenticate',
		'proxy-authorization',
		'te',
		'trailer',
		'transfer-encoding',
		'upgrade',
	].includes(name.toLowerCase());
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}
