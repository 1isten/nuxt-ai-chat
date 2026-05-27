// Copilot SDK integration: a singleton CopilotClient + per-chat session helpers
// + an adapter that translates Copilot session events into the AI-SDK
// UI Message Stream protocol expected by the frontend (`@ai-sdk/vue` `Chat`).
//
// Public entry points:
//   - getCopilotClient()           : lazy singleton
//   - configureCopilot(opts)       : override defaults (e.g. from Electron host)
//   - runChatTurn(args)            : returns a Response with the streaming body
//
// The frontend never knows about Copilot; it keeps consuming the same
// AI-SDK UI Message Stream chunks as before (text-delta / reasoning-delta /
// tool-input-available / tool-output-available / data-* / finish).

import {
  CopilotClient,
  approveAll,
  defineTool,
  type ModelInfo,
  type ProviderConfig,
  type SessionConfig,
  type SessionEvent,
} from '@github/copilot-sdk';
import {
  generateText,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModel,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { cleanGeneratedChatTitle } from './chatTitle';
import type { ModelMetadata, ReasoningEffort, ReasoningEffortValue } from '../../shared/utils/models';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CopilotRuntimeConfig {
  /** Working directory the agent's file-system tools see as `cwd`. */
  workingDirectory: string;
  /** Optional GitHub token for dev (overridden by useLoggedInUser unless set). */
  gitHubToken?: string;
  /** Default to using the user logged into the local `copilot` CLI. */
  useLoggedInUser: boolean;
  /**
   * Environment variables for the spawned Copilot CLI subprocess only.
   * Defaults to `process.env`. Hosts (e.g. Electron) can override this to
   * inject vars like `ELECTRON_RUN_AS_NODE=1` without polluting the parent
   * process env (which would break Electron's own helper children).
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional override for the path to the Copilot CLI entrypoint. Hosts
   * (e.g. Electron) can point this at a shim that prepares the runtime
   * environment before importing `@github/copilot`.
   */
  cliPath?: string;
}

let _config: CopilotRuntimeConfig = {
  workingDirectory: process.cwd(),
  gitHubToken: process.env.COPILOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
  useLoggedInUser: true,
};

export function configureCopilot(patch: Partial<CopilotRuntimeConfig>): void {
  _config = { ..._config, ...patch };
}

export function getCopilotConfig(): CopilotRuntimeConfig {
  return _config;
}

// ---------------------------------------------------------------------------
// Singleton CopilotClient
// ---------------------------------------------------------------------------

let _client: CopilotClient | null = null;
let _starting: Promise<CopilotClient> | null = null;

export async function getCopilotClient(): Promise<CopilotClient> {
  if (_client) return _client;
  if (_starting) return _starting;

  _starting = (async () => {
    const cfg = _config;
    const client = new CopilotClient({
      ...(cfg.gitHubToken ? { gitHubToken: cfg.gitHubToken } : {}),
      useLoggedInUser: cfg.useLoggedInUser && !cfg.gitHubToken,
      ...(cfg.env ? { env: cfg.env } : {}),
      ...(cfg.cliPath ? { cliPath: cfg.cliPath } : {}),
    });
    try {
      await client.start();
      _client = client;
      return client;
    } catch (err) {
      _starting = null;
      try { await client.stop(); } catch { /* ignore */ }
      throw err;
    }
  })();
  return _starting;
}

export async function stopCopilotClient(): Promise<void> {
  if (_client) {
    try { await _client.stop(); } catch { /* ignore */ }
    _client = null;
    _starting = null;
  }
}

// Best-effort cleanup
process.once('SIGINT', () => { void stopCopilotClient(); });
process.once('SIGTERM', () => { void stopCopilotClient(); });
process.once('beforeExit', () => { void stopCopilotClient(); });

// ---------------------------------------------------------------------------
// Built-in tools (chart, weather) wrapped for Copilot SDK
// ---------------------------------------------------------------------------

const seriesZod = z.array(z.object({
  key: z.string(),
  name: z.string(),
  color: z.string(),
})).min(1);

const xySeriesDataZod = z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1);

const chartZod = z.object({
  title: z.string().optional(),
  data: xySeriesDataZod,
  xKey: z.string(),
  series: seriesZod,
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});

const barChartZod = z.object({
  title: z.string().optional(),
  data: xySeriesDataZod,
  xKey: z.string(),
  series: seriesZod,
  stacked: z.boolean().optional(),
  horizontal: z.boolean().optional(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});

const donutChartZod = z.object({
  title: z.string().optional(),
  data: z.array(z.object({
    label: z.string(),
    value: z.number(),
    color: z.string(),
  })).min(2).max(8),
  variant: z.enum(['donut', 'pie']).optional(),
});

const areaChartZod = z.object({
  title: z.string().optional(),
  data: xySeriesDataZod,
  xKey: z.string(),
  series: seriesZod,
  stacked: z.boolean().optional(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});

const weatherZod = z.object({
  location: z.string(),
});

function getWeatherCondition(k: string) {
  return ({
    'sunny': { text: 'Sunny', icon: 'i-lucide-sun' },
    'partly-cloudy': { text: 'Partly Cloudy', icon: 'i-lucide-cloud-sun' },
    'cloudy': { text: 'Cloudy', icon: 'i-lucide-cloud' },
    'rainy': { text: 'Rainy', icon: 'i-lucide-cloud-rain' },
    'foggy': { text: 'Foggy', icon: 'i-lucide-cloud-fog' },
  } as Record<string, { text: string; icon: string }>)[k] || { text: 'Sunny', icon: 'i-lucide-sun' };
}

function buildBuiltInTools() {
  return [
    defineTool('chart', {
      description: 'Create a LINE chart for continuous data on an ORDERED x-axis (time series, dates, sequential indices). Use for trends and how metrics change over an ordered axis. Do NOT use for discrete categories (use bar_chart), proportions of a whole (use donut_chart), or cumulative totals (use area_chart).',
      parameters: chartZod,
      skipPermission: true,
      handler: async (input) => input,
    }),
    defineTool('bar_chart', {
      description: 'Create a BAR chart to compare DISCRETE INDEPENDENT categories (modalities, patient names, file types, regions). Use whenever the x-axis is a list of category labels rather than an ordered numeric/time axis, especially for counts/sums/comparisons across categories. Supports grouped, stacked (`stacked:true`), and horizontal (`horizontal:true`) layouts. Do NOT use for ordered/continuous axes (use chart), proportions of a whole (use donut_chart). Examples: "instances per modality", "files per patient".',
      parameters: barChartZod,
      skipPermission: true,
      handler: async (input) => input,
    }),
    defineTool('donut_chart', {
      description: 'Create a DONUT or PIE chart to show PROPORTIONS of a single whole (parts-of-a-total). Use only when values truly sum to a meaningful total AND there are at most 6-7 slices. Default visual is a donut; set `variant:"pie"` for a solid pie. ALWAYS honor user wording: set `variant:"pie"` when the user says "pie"/"pie chart"; set `variant:"donut"` when the user says "donut"/"doughnut"/"ring"; omit `variant` if unspecified. Do NOT use to compare absolute values across categories (use bar_chart). Do NOT use with many categories. Do NOT use for time series. Examples: "share of modalities", "distribution of patient genders".',
      parameters: donutChartZod,
      skipPermission: true,
      handler: async (input) => input,
    }),
    defineTool('area_chart', {
      description: 'Create an AREA chart to emphasize CUMULATIVE MAGNITUDE or COMPOSITION over an ordered axis (typically time). Use when totals matter, especially when stacking multiple series whose sum is itself meaningful (`stacked:true`). For pure trend lines without filled area, prefer `chart`. Do NOT use for discrete independent categories (use bar_chart) or single-point proportions (use donut_chart).',
      parameters: areaChartZod,
      skipPermission: true,
      handler: async (input) => input,
    }),
    defineTool('weather', {
      description: 'Get weather info with a 5-day forecast for a given location.',
      parameters: weatherZod,
      skipPermission: true,
      handler: async ({ location }) => {
        const temp = Math.floor(Math.random() * 35) + 5;
        const conds = ['sunny', 'partly-cloudy', 'cloudy', 'rainy', 'foggy'];
        return {
          location,
          temperature: Math.round(temp),
          temperatureHigh: Math.round(temp + Math.random() * 5 + 2),
          temperatureLow: Math.round(temp - Math.random() * 5 - 2),
          condition: getWeatherCondition(conds[Math.floor(Math.random() * conds.length)]!),
          humidity: Math.floor(Math.random() * 60) + 20,
          windSpeed: Math.floor(Math.random() * 25) + 5,
          dailyForecast: ['Today', 'Tomorrow', 'Thu', 'Fri', 'Sat'].map((day, i) => ({
            day,
            high: Math.round(temp + Math.random() * 8 - 2),
            low: Math.round(temp - Math.random() * 8 - 3),
            condition: getWeatherCondition(conds[(Math.floor(Math.random() * conds.length) + i) % conds.length]!),
          })),
        };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Session lifecycle: get or (re)create per-chat session
// ---------------------------------------------------------------------------

interface RunArgs {
  chatId: string;
  model: string;
  provider?: ProviderConfig;
  reasoningEffort?: ReasoningEffortValue;
  /** Latest user prompt text. */
  prompt: string;
  /** Optional file URLs (from front-end). Currently mapped to attachments by URL string when local file paths are provided. */
  attachments?: Array<{ type: string; url?: string; mediaType?: string }>;
  systemMessage?: string;
  /** Called once we have the final assistant UIMessage(s) to persist. */
  onFinish?: (assistantMessages: UIMessage[]) => Promise<void> | void;
  /** Forces fresh session (used after edit/regenerate truncation). */
  forceNew?: boolean;
  signal?: AbortSignal;
  /** Optional title to broadcast as a `data-chat-title` UI chunk. */
  chatTitle?: string;
  /** Skill parent directories to load. */
  skillDirectories?: string[];
  /** Skill names to disable. */
  disabledSkills?: string[];
  /** Pre-rendered skills block to prepend to the system message (eager injection). */
  skillsSystemFragment?: string;
}

const SYSTEM_MESSAGE_DEFAULT = `You are a knowledgeable and helpful AI assistant with access to file-system tools.
Your goal is to provide clear, accurate, well-structured responses.

FORMATTING RULES (CRITICAL):
- ABSOLUTELY NO MARKDOWN HEADINGS: Never use #, ##, ###, ####, #####, or ######
- NO underline-style headings with === or ---
- Use **bold text** for emphasis and section labels instead
- Start all responses with content, never with a heading

RESPONSE QUALITY:
- Be concise yet comprehensive
- Use examples when helpful
- Maintain a friendly, professional tone`;

const TITLE_SYSTEM_MESSAGE = `Generate a short title (max 30 characters) based on the user's message. No quotes or punctuation.
Return only the title. Do not answer the user's message. Use the user's language when practical.

Good examples:
User message: what model are you?
Title: Model Identity

User message: help me debug nuxt auth cookie issue
Title: Nuxt Auth Debugging

User message: compare files per modality
Title: Modality File Comparison

Bad examples:
User message: what model are you?
Bad title: I'm powered by GPT-4.1
Bad title: what model are you?`;

const TITLE_GENERATION_TIMEOUT_MS = 20_000;

type SdkReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;

function reasoningEffortConfig(reasoningEffort?: ReasoningEffortValue): { reasoningEffort?: SdkReasoningEffort } {
  return reasoningEffort
    ? { reasoningEffort: reasoningEffort as SdkReasoningEffort }
    : {};
}

async function getOrCreateSession(args: {
  chatId: string;
  model: string;
  provider?: ProviderConfig;
  reasoningEffort?: ReasoningEffortValue;
  systemMessage: string;
  forceNew?: boolean;
  skillDirectories?: string[];
  disabledSkills?: string[];
}) {
  const client = await getCopilotClient();
  const cfg = _config;

  const skillsCfg = {
    ...(args.skillDirectories?.length ? { skillDirectories: args.skillDirectories } : {}),
    ...(args.disabledSkills?.length ? { disabledSkills: args.disabledSkills } : {}),
  };

  const baseConfig = {
    sessionId: args.chatId,
    model: args.model,
    streaming: true,
    onPermissionRequest: approveAll,
    workingDirectory: cfg.workingDirectory,
    tools: buildBuiltInTools(),
    systemMessage: { content: args.systemMessage },
    ...reasoningEffortConfig(args.reasoningEffort),
    ...(args.provider ? { provider: args.provider } : {}),
    ...skillsCfg,
  };

  if (args.forceNew) {
    try { await client.deleteSession(args.chatId); } catch { /* ignore */ }
  } else {
    try {
      return await client.resumeSession(args.chatId, {
        model: args.model,
        streaming: true,
        onPermissionRequest: approveAll,
        workingDirectory: cfg.workingDirectory,
        tools: buildBuiltInTools(),
        ...reasoningEffortConfig(args.reasoningEffort),
        ...(args.provider ? { provider: args.provider } : {}),
        ...skillsCfg,
      });
    } catch {
      // session doesn't exist yet — fall through to create
    }
  }

  return await client.createSession(baseConfig);
}

// ---------------------------------------------------------------------------
// Adapter: Copilot SessionEvent → AI-SDK UIMessageChunk
// ---------------------------------------------------------------------------

interface AdapterState {
  /** Track which messageIds we've started a text part for. */
  textStarted: Set<string>;
  /** Per-messageId text accumulated from `assistant.message_delta` events,
   *  used as a fallback for persistence when the final `assistant.message`
   *  event arrives with empty `content`. */
  textBuffers: Map<string, string>;
  /** Track which reasoningIds we've started a reasoning part for. */
  reasoningStarted: Set<string>;
  /** Tool calls we've already announced input-available for. */
  toolInputAnnounced: Set<string>;
  toolNames: Map<string, string>;
  /** Per-toolCallId input arguments captured at execution_start. */
  toolInputs: Map<string, unknown>;
  /** Accumulated final assistant message parts to persist. */
  finalParts: UIMessage['parts'];
  /** Generated assistant message id, used as the streaming UIMessage id. */
  assistantMessageId: string;
}

function newState(assistantMessageId: string): AdapterState {
  return {
    textStarted: new Set(),
    textBuffers: new Map(),
    reasoningStarted: new Set(),
    toolInputAnnounced: new Set(),
    toolNames: new Map(),
    toolInputs: new Map(),
    finalParts: [],
    assistantMessageId,
  };
}

function translateEvent(event: SessionEvent, state: AdapterState): UIMessageChunk[] {
  const out: UIMessageChunk[] = [];

  switch (event.type) {
    case 'assistant.message_delta': {
      const id = event.data.messageId;
      const delta = event.data.deltaContent;
      if (!state.textStarted.has(id)) {
        state.textStarted.add(id);
        out.push({ type: 'text-start', id } as UIMessageChunk);
      }
      state.textBuffers.set(id, (state.textBuffers.get(id) ?? '') + delta);
      out.push({ type: 'text-delta', id, delta } as UIMessageChunk);
      break;
    }

    case 'assistant.reasoning_delta': {
      const id = event.data.reasoningId;
      if (!state.reasoningStarted.has(id)) {
        state.reasoningStarted.add(id);
        out.push({ type: 'reasoning-start', id } as UIMessageChunk);
      }
      out.push({ type: 'reasoning-delta', id, delta: event.data.deltaContent } as UIMessageChunk);
      break;
    }

    case 'assistant.reasoning': {
      const id = event.data.reasoningId;
      if (state.reasoningStarted.has(id)) {
        out.push({ type: 'reasoning-end', id } as UIMessageChunk);
        state.reasoningStarted.delete(id);
      }
      // Accumulate for persistence
      state.finalParts.push({ type: 'reasoning', text: event.data.content } as UIMessage['parts'][number]);
      break;
    }

    case 'assistant.message': {
      const id = event.data.messageId;
      if (state.textStarted.has(id)) {
        out.push({ type: 'text-end', id } as UIMessageChunk);
        state.textStarted.delete(id);
      }
      // Prefer the consolidated `content`, fall back to the accumulated
      // streaming deltas for this messageId. Some Copilot models only emit
      // text via `assistant.message_delta` and leave `content` empty.
      const text = event.data.content || state.textBuffers.get(id) || '';
      state.textBuffers.delete(id);
      if (text) {
        state.finalParts.push({ type: 'text', text } as UIMessage['parts'][number]);
      }
      // Tool requests in this message are emitted via separate tool.* events.
      break;
    }

    case 'tool.execution_start': {
      const { toolCallId, toolName } = event.data;
      state.toolNames.set(toolCallId, toolName);
      const input = event.data.arguments ?? {};
      state.toolInputs.set(toolCallId, input);
      // Close any open text part so the tool call sits between text parts.
      for (const id of state.textStarted) {
        out.push({ type: 'text-end', id } as UIMessageChunk);
      }
      state.textStarted.clear();
      // Frontend expects type `tool-${toolName}` parts. Use AI-SDK chunk types.
      out.push({
        type: 'tool-input-available',
        toolCallId,
        toolName,
        input,
      } as UIMessageChunk);
      state.toolInputAnnounced.add(toolCallId);
      break;
    }

    case 'tool.execution_complete': {
      const { toolCallId, success, error } = event.data;
      const toolName = state.toolNames.get(toolCallId) ?? 'unknown';
      const input = state.toolInputs.get(toolCallId) ?? {};
      if (!state.toolInputAnnounced.has(toolCallId)) {
        // Edge case: complete arrived without start — emit a synthetic input chunk
        out.push({
          type: 'tool-input-available',
          toolCallId,
          toolName,
          input,
        } as UIMessageChunk);
        state.toolInputAnnounced.add(toolCallId);
      }

      if (success && event.data.result) {
        const raw = event.data.result.detailedContent ?? event.data.result.content;
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep as string */ }
        out.push({
          type: 'tool-output-available',
          toolCallId,
          output: parsed,
        } as UIMessageChunk);
        // For DB persistence, store as a tool part the same shape AI-SDK uses
        state.finalParts.push({
          type: `tool-${toolName}`,
          toolCallId,
          state: 'output-available',
          input,
          output: parsed,
        } as unknown as UIMessage['parts'][number]);
      } else {
        const errorText = error?.message ?? 'Tool execution failed';
        out.push({
          type: 'tool-output-error',
          toolCallId,
          errorText,
        } as UIMessageChunk);
        state.finalParts.push({
          type: `tool-${toolName}`,
          toolCallId,
          state: 'output-error',
          input,
          errorText,
        } as unknown as UIMessage['parts'][number]);
      }
      state.toolInputs.delete(toolCallId);
      break;
    }

    default:
      // Ignore other events (turn_start, turn_end, usage, intent, idle, etc.)
      break;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public: run a chat turn and return a Response with the UI message stream
// ---------------------------------------------------------------------------

/** Per-chat fingerprint of the last model+provider used, so we can detect
 *  a config change and recreate the underlying Copilot session. */
const _lastConfigByChat = new Map<string, string>();

function configFingerprint(model: string, provider?: ProviderConfig, reasoningEffort?: ReasoningEffortValue, disabledSkills?: string[], skillsSystemFragment?: string): string {
  const skills = disabledSkills?.length ? [...disabledSkills].sort() : null;
  return JSON.stringify({
    model,
    provider: provider ?? null,
    reasoningEffort: reasoningEffort ?? null,
    skills,
    fragment: skillsSystemFragment || null,
  });
}

export async function runChatTurn(args: RunArgs): Promise<Response> {
  const assistantMessageId = crypto.randomUUID();
  const state = newState(assistantMessageId);

  const fingerprint = configFingerprint(args.model, args.provider, args.reasoningEffort, args.disabledSkills, args.skillsSystemFragment);
  const previous = _lastConfigByChat.get(args.chatId);
  const configChanged = previous !== undefined && previous !== fingerprint;
  _lastConfigByChat.set(args.chatId, fingerprint);

  const baseSystem = args.systemMessage ?? SYSTEM_MESSAGE_DEFAULT;
  const systemMessage = args.skillsSystemFragment
    ? `${args.skillsSystemFragment}\n\n---\n\n${baseSystem}`
    : baseSystem;

  const session = await getOrCreateSession({
    chatId: args.chatId,
    model: args.model,
    provider: args.provider,
    reasoningEffort: args.reasoningEffort,
    systemMessage,
    forceNew: args.forceNew || configChanged,
    skillDirectories: args.skillDirectories,
    disabledSkills: args.disabledSkills,
  });

  // Build a UIMessageStream and wire Copilot session events into it.
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'start', messageId: assistantMessageId } as UIMessageChunk);

      if (args.chatTitle) {
        writer.write({
          type: 'data-chat-title',
          data: { title: args.chatTitle },
        } as unknown as UIMessageChunk);
      }

      const idle = new Promise<void>((resolve, reject) => {
        const offEvent = session.on((event) => {
          try {
            for (const chunk of translateEvent(event, state)) writer.write(chunk);
          } catch (err) {
            reject(err as Error);
          }
        });

        const offIdle = session.on('session.idle', () => {
          offEvent();
          offIdle();
          resolve();
        });

        // Also resolve on session error events to avoid hangs
        const offErr = session.on('session.error', (e) => {
          offEvent();
          offIdle();
          offErr();
          const errorEvent = e as { data?: { message?: string } };
          reject(new Error(errorEvent.data?.message ?? 'Copilot session error'));
        });

        if (args.signal) {
          const onAbort = () => {
            void session.abort();
            offEvent();
            offIdle();
            offErr();
            resolve();
          };
          if (args.signal.aborted) onAbort();
          else args.signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      // Map front-end attachments → Copilot SDK attachments. Currently only
      // local file paths are supported; remote URLs are skipped (the frontend
      // already includes them as parts of the user UIMessage stored in DB).
      const sdkAttachments = (args.attachments ?? [])
        .filter((a) => a.type === 'file' && a.url && a.url.startsWith('file://'))
        .map((a) => ({ type: 'file' as const, path: new URL(a.url!).pathname }));

      await session.send({
        prompt: args.prompt,
        ...(sdkAttachments.length ? { attachments: sdkAttachments } : {}),
      });

      try {
        await idle;
      } finally {
        // Flush any text buffers that didn't receive a closing
        // `assistant.message` event (e.g. session went idle on abort/error
        // mid-stream). Without this, the persisted assistant message would
        // have empty parts and the chat would appear to "lose" the reply.
        for (const [id, text] of state.textBuffers) {
          if (state.textStarted.has(id)) {
            try { state.textStarted.delete(id); } catch { /* ignore */ }
          }
          if (text) {
            state.finalParts.push({ type: 'text', text } as UIMessage['parts'][number]);
          }
        }
        state.textBuffers.clear();

        // Build the final assistant UIMessage and persist
        const finalMessage: UIMessage = {
          id: assistantMessageId,
          role: 'assistant',
          parts: state.finalParts as UIMessage['parts'],
        } as UIMessage;
        try { await args.onFinish?.([finalMessage]); } catch (err) { console.error('[copilot] onFinish error', err); }

        // Disconnect to free resources; data on disk is preserved.
        try { await session.disconnect(); } catch { /* ignore */ }
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

export async function generateChatTitle(args: {
  chatId: string;
  model: string;
  provider?: ProviderConfig;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { provider } = args;
  if (provider) {
    return await generateChatTitleWithAiSdk({ ...args, provider });
  }

  return await generateChatTitleWithCopilot(args);
}

async function generateChatTitleWithAiSdk(args: {
  model: string;
  provider: ProviderConfig;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (args.signal?.aborted) return null;

  const model = resolveTitleLanguageModel(args.model, args.provider);
  if (!model) return null;

  try {
    const result = await generateText({
      model,
      system: TITLE_SYSTEM_MESSAGE,
      prompt: args.prompt,
      providerOptions: titleProviderOptions(args.provider),
      abortSignal: args.signal,
      timeout: TITLE_GENERATION_TIMEOUT_MS,
    });

    return cleanGeneratedChatTitle(result.text);
  } catch {
    return null;
  }
}

async function generateChatTitleWithCopilot(args: {
  chatId: string;
  model: string;
  provider?: ProviderConfig;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const client = await getCopilotClient();
  const sessionId = `title-${args.chatId}-${crypto.randomUUID()}`;
  const session = await client.createSession({
    sessionId,
    model: args.model,
    streaming: false,
    onPermissionRequest: approveAll,
    workingDirectory: _config.workingDirectory,
    tools: [],
    availableTools: [],
    systemMessage: { content: TITLE_SYSTEM_MESSAGE },
    ...(args.provider ? { provider: args.provider } : {}),
  });

  const onAbort = () => { void session.abort(); };
  try {
    if (args.signal?.aborted) return null;
    args.signal?.addEventListener('abort', onAbort, { once: true });

    const response = await session.sendAndWait({
      prompt: args.prompt,
    }, TITLE_GENERATION_TIMEOUT_MS);

    return cleanGeneratedChatTitle(response?.data.content);
  } finally {
    args.signal?.removeEventListener('abort', onAbort);
    try { await session.disconnect(); } catch { /* ignore */ }
    try { await client.deleteSession(sessionId); } catch { /* ignore */ }
  }
}

function resolveTitleLanguageModel(model: string, provider: ProviderConfig): LanguageModel | null {
  if ((provider.type ?? 'openai') === 'anthropic') {
    const anthropic = createAnthropic({
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey ?? (provider.bearerToken ? undefined : 'unused'),
      authToken: provider.bearerToken,
      headers: provider.headers,
      name: 'byok-anthropic',
    });
    return anthropic(model);
  }

  if ((provider.type ?? 'openai') === 'openai') {
    const headers = provider.bearerToken
      ? { ...provider.headers, Authorization: `Bearer ${provider.bearerToken}` }
      : provider.headers;
    const openai = createOpenAI({
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey ?? provider.bearerToken ?? 'unused',
      headers,
      name: 'byok-openai',
    });
    return provider.wireApi === 'responses' ? openai.responses(model) : openai.chat(model);
  }

  return null;
}

function titleProviderOptions(provider: ProviderConfig) {
  if ((provider.type ?? 'openai') === 'anthropic') {
    return {
      anthropic: {
        thinking: { type: 'disabled' },
      },
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers used by other handlers
// ---------------------------------------------------------------------------

/** Drop the persisted Copilot session for a chat (e.g. on chat delete or
 *  edit/regenerate). Errors are swallowed since the session may not exist. */
export async function dropCopilotSession(chatId: string): Promise<void> {
  _lastConfigByChat.delete(chatId);
  if (!_client) return;
  try { await _client.deleteSession(chatId); } catch { /* ignore */ }
}

/** List models exposed by the Copilot CLI. Empty array on failure. */
export async function listCopilotModels(): Promise<Array<{ id: string; name: string }>> {
  const result = await getCopilotModelsStatus();
  return result.models;
}

export interface CopilotModelsStatus {
  models: ModelMetadata[];
  copilot: {
    available: boolean;
    message?: string;
  };
}

function mapModelInfo(model: ModelInfo): ModelMetadata {
  return {
    id: model.id,
    name: model.name,
    contextWindowTokens: model.capabilities?.limits?.max_context_window_tokens || undefined,
    maxPromptTokens: model.capabilities?.limits?.max_prompt_tokens,
    supportsReasoningEffort: model.capabilities?.supports?.reasoningEffort || false,
    supportedReasoningEfforts: model.supportedReasoningEfforts as ReasoningEffort[] | undefined,
    defaultReasoningEffort: model.defaultReasoningEffort as ReasoningEffort | undefined,
  };
}

/** List models and report whether local Copilot auth/runtime is usable. */
export async function getCopilotModelsStatus(): Promise<CopilotModelsStatus> {
  try {
    const client = await getCopilotClient();
    const models = await client.listModels();
    return {
      models: models.map(mapModelInfo),
      copilot: { available: true },
    };
  } catch (err) {
    console.error('[copilot] listModels failed', err);
    return {
      models: [],
      copilot: {
        available: false,
        message: 'Sign in to GitHub Copilot in your terminal, or enable BYOK provider settings.',
      },
    };
  }
}
