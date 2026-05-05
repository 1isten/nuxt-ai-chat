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
  type ProviderConfig,
  type SessionEvent,
} from '@github/copilot-sdk';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { z } from 'zod';

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
    await client.start();
    _client = client;
    return client;
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

const chartZod = z.object({
  title: z.string().optional(),
  data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1),
  xKey: z.string(),
  series: z.array(z.object({
    key: z.string(),
    name: z.string(),
    color: z.string(),
  })).min(1),
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
      description: 'Create a line chart visualization. Use for time-series, trends, or comparing metrics.',
      parameters: chartZod,
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

async function getOrCreateSession(args: {
  chatId: string;
  model: string;
  provider?: ProviderConfig;
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

function configFingerprint(model: string, provider?: ProviderConfig, disabledSkills?: string[], skillsSystemFragment?: string): string {
  const skills = disabledSkills?.length ? [...disabledSkills].sort() : null;
  return JSON.stringify({
    model,
    provider: provider ?? null,
    skills,
    fragment: skillsSystemFragment || null,
  });
}

export async function runChatTurn(args: RunArgs): Promise<Response> {
  const assistantMessageId = crypto.randomUUID();
  const state = newState(assistantMessageId);

  const fingerprint = configFingerprint(args.model, args.provider, args.disabledSkills, args.skillsSystemFragment);
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
  try {
    const client = await getCopilotClient();
    const models = await client.listModels();
    return models.map((m) => ({ id: m.id, name: m.name }));
  } catch (err) {
    console.error('[copilot] listModels failed', err);
    return [];
  }
}
