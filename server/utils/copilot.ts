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
import type { ModelMetadata, ReasoningEffort, ReasoningEffortValue, ProviderConfigClient } from '../../shared/utils/models';
import { OLLAMA_BASE_URL, OLLAMA_DEFAULT_WIRE_API } from '../../shared/utils/models';

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
// Provider mapping: the UI's provider kinds → the Copilot SDK's provider types
// ---------------------------------------------------------------------------

/**
 * True when the request should be served by a local Ollama server.
 *
 * Ollama is a UI-level kind: the SDK only understands `openai | azure |
 * anthropic`, so Ollama is translated to a generic OpenAI-compatible provider
 * before it ever reaches the SDK.
 */
export function isOllamaProvider(provider?: ProviderConfigClient): boolean {
  return provider?.type === 'ollama';
}

/**
 * Convert the client's provider settings into an SDK `ProviderConfig`.
 *
 * - `ollama` → `{ type: 'openai' }` with the Responses wire API. The Responses
 *   API is required, not cosmetic: Ollama only emits its structured `reasoning`
 *   output items (which become UI reasoning deltas) on that wire, and tool
 *   calling is markedly less reliable on Chat Completions.
 * - Ollama needs no API key; the SDK documents `apiKey` as optional for local
 *   providers, so it is omitted rather than sent as an empty string.
 */
export function toSdkProvider(provider: ProviderConfigClient): ProviderConfig {
  if (isOllamaProvider(provider)) {
    return {
      type: 'openai',
      baseUrl: provider.baseUrl || OLLAMA_BASE_URL,
      wireApi: provider.wireApi ?? OLLAMA_DEFAULT_WIRE_API,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
    };
  }

  return { ...provider, type: provider.type ?? 'openai' } as ProviderConfig;
}

/** Stable identity for a provider, used to key pooled Copilot clients. */
function providerPoolKey(provider: ProviderConfigClient | undefined, offline: boolean): string {
  if (!isOllamaProvider(provider)) return 'default';
  return `ollama:${JSON.stringify({
    baseUrl: provider?.baseUrl || OLLAMA_BASE_URL,
    wireApi: provider?.wireApi ?? OLLAMA_DEFAULT_WIRE_API,
    offline,
  })}`;
}

// ---------------------------------------------------------------------------
// CopilotClient pool
//
// The default client serves GitHub-hosted models and remote BYOK providers.
// Offline / Ollama requests need their own client because `COPILOT_OFFLINE` and
// `COPILOT_PROVIDER_*` are *process-level* environment variables: they must be
// present when the CLI is spawned, and the CLI refuses to start in offline mode
// unless `COPILOT_PROVIDER_BASE_URL` is set in that environment. The SDK still
// requires the provider to be passed per session, so both must be supplied.
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

interface PooledClient {
  client: CopilotClient | null;
  starting: Promise<CopilotClient> | null;
}

const _pool = new Map<string, PooledClient>();

/** Environment overrides for a CLI spawned against a local Ollama server. */
function ollamaClientEnv(baseUrl: string, offline: boolean, model: string): NodeJS.ProcessEnv {
  return {
    ...(_config.env ?? process.env),
    ...(offline ? { COPILOT_OFFLINE: 'true' } : {}),
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_BASE_URL: baseUrl,
    COPILOT_PROVIDER_WIRE_API: OLLAMA_DEFAULT_WIRE_API,
    // BYOK providers require an explicit model *at CLI startup*, before any
    // session exists ("BYOK providers require an explicit model"). Each session
    // still carries its own `model`, so this only fixes the startup default.
    COPILOT_MODEL: model,
  };
}

/**
 * Resolve the client that should serve this request.
 *
 * `offline` comes from the user's settings rather than the provider object,
 * because it is a session-wide toggle rather than a provider property.
 */
export async function getCopilotClientFor(
  provider?: ProviderConfigClient,
  offline = false,
  model = '',
): Promise<CopilotClient> {
  if (!isOllamaProvider(provider)) return await getCopilotClient();

  const baseUrl = provider?.baseUrl || OLLAMA_BASE_URL;
  const key = providerPoolKey(provider, offline);
  let entry = _pool.get(key);
  if (!entry) {
    entry = { client: null, starting: null };
    _pool.set(key, entry);
  }
  if (entry.client) return entry.client;
  if (entry.starting) return entry.starting;

  const slot = entry;
  slot.starting = (async () => {
    const cfg = _config;
    const client = new CopilotClient({
      useLoggedInUser: false,
      ...(cfg.cliPath ? { cliPath: cfg.cliPath } : {}),
      env: ollamaClientEnv(baseUrl, offline, model),
    });
    try {
      await client.start();
      slot.client = client;
      return client;
    } catch (err) {
      slot.starting = null;
      try { await client.stop(); } catch { /* ignore */ }
      throw err;
    }
  })();

  return slot.starting;
}

export async function stopCopilotClient(): Promise<void> {
  if (_client) {
    try { await _client.stop(); } catch { /* ignore */ }
    _client = null;
    _starting = null;
  }
  for (const entry of _pool.values()) {
    if (entry.client) {
      try { await entry.client.stop(); } catch { /* ignore */ }
    }
  }
  _pool.clear();
}

// Best-effort cleanup
process.once('SIGINT', () => { void stopCopilotClient(); });
process.once('SIGTERM', () => { void stopCopilotClient(); });
process.once('beforeExit', () => { void stopCopilotClient(); });

// ---------------------------------------------------------------------------
// Built-in tools (chart, weather) wrapped for Copilot SDK
// ---------------------------------------------------------------------------

const seriesZod = z.array(z.object({
  key: z.string().describe('Name of the field in each data object that holds this series\' numeric value. It MUST be a real property of every data object (never the series display name or colour).'),
  name: z.string().describe('Display name for this series in the legend.'),
  color: z.string().describe('Hex colour for this series (e.g. "#3b82f6").'),
})).min(1).describe('One entry per plotted series (each becomes a set of bars / a line).');

const xySeriesDataZod = z.preprocess(
  coerceRecordArray,
  z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1),
).describe('The data points themselves: one object per x position. Each object must contain the xKey field plus EVERY series key, and each series-key value must be a NUMBER. Do not put series definitions ({key,name,color} objects) in here. This MUST be a JSON array, not a JSON-encoded string.');

/**
 * Recover a `data` value the model serialised instead of passing as an array.
 *
 * Small models frequently send `"[{\"a\":1}]"` or `"[[{\"a\":1}]]"` for an
 * array parameter. The mistake is unambiguous to undo, so undo it rather than
 * failing the call — but never guess at a re-shaping that loses information
 * (e.g. a `{categories, data:[45,120,380]}` wrapper, whose mapping is a guess).
 */
function coerceRecordArray(value: unknown): unknown {
  let result = value;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { return value; }
  }
  if (Array.isArray(result) && result.length === 1 && Array.isArray(result[0])) {
    result = result[0];
  }
  return result;
}

const chartZod = z.object({
  title: z.string().optional().describe('Chart title.'),
  data: xySeriesDataZod,
  xKey: z.string().describe('Field name in each data object holding the x value (e.g. "month", "date", "index").'),
  series: seriesZod,
  xLabel: z.string().optional().describe('Optional x-axis label.'),
  yLabel: z.string().optional().describe('Optional y-axis label.'),
});

const barChartZod = z.object({
  title: z.string().optional().describe('Chart title.'),
  data: xySeriesDataZod,
  xKey: z.string().describe('Field name in each data object holding the CATEGORY label (e.g. "category", "modality", "patient").'),
  series: seriesZod,
  stacked: z.boolean().optional().describe('Stack the series into one bar per category instead of grouping them.'),
  horizontal: z.boolean().optional().describe('Render bars horizontally; prefer this when category labels are long.'),
  xLabel: z.string().optional().describe('Optional category-axis label.'),
  yLabel: z.string().optional().describe('Optional value-axis label.'),
});

const donutChartZod = z.object({
  title: z.string().optional().describe('Chart title.'),
  data: z.array(z.object({
    label: z.string().describe('Slice label shown in the legend.'),
    value: z.number().describe('Slice value (raw counts or percentages both work).'),
    color: z.string().describe('Hex colour for this slice.'),
  })).min(2).max(8).describe('One entry per slice (2-8); these values must sum to a meaningful whole.'),
  variant: z.enum(['donut', 'pie']).optional().describe('"donut" (default) or "pie" — follow the wording the user used.'),
});

const areaChartZod = z.object({
  title: z.string().optional().describe('Chart title.'),
  data: xySeriesDataZod,
  xKey: z.string().describe('Field name in each data object holding the x value.'),
  series: seriesZod,
  stacked: z.boolean().optional().describe('Stack the series so their cumulative sum is shown.'),
  xLabel: z.string().optional().describe('Optional x-axis label.'),
  yLabel: z.string().optional().describe('Optional y-axis label.'),
});

const weatherZod = z.object({
  location: z.string(),
});

const findingsZod = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  findings: z.array(z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]).optional(),
    severity: z.enum(['critical', 'warning', 'abnormal', 'normal', 'info']).optional(),
    detail: z.string().optional(),
  })),
});

const histogramZod = z.object({
  title: z.string().optional(),
  bins: z.number().min(2).max(256),
  min: z.number(),
  max: z.number(),
  counts: z.array(z.number()),
  statistics: z.object({
    mean: z.number(),
    median: z.number(),
    stddev: z.number().optional(),
    min: z.number(),
    max: z.number(),
  }).optional(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});

/**
 * Catch the most common malformed chart call before it reaches the renderer.
 *
 * The xy tools are contract-based: the renderer resolves each `series.key` as a
 * property of every `data` object. A model that instead fills `data` with
 * series *definitions* ({key, name, color} objects) still satisfies the types,
 * but every lookup misses — the chart renders with zero-height bars and "N/A"
 * tooltips, which looks like a renderer bug and teaches the model nothing.
 * Returning a described error instead lets the model correct itself.
 */
function chartContractIssues(
  input: { data: Array<Record<string, unknown>>; xKey: string; series: Array<{ key: string }> },
): string | undefined {
  const rows = input.data ?? [];
  if (!rows.length) return 'data must contain at least one object.';

  const problems: string[] = [];

  // `xKey` is the axis label, so it is needed on every point.
  const withoutXKey = rows.filter((row) => !(input.xKey in row)).length;
  if (withoutXKey) {
    problems.push(`xKey "${input.xKey}" is missing from ${withoutXKey} of ${rows.length} data objects (fields found: ${Object.keys(rows[0]!).join(', ')})`);
  }

  // A series only has to appear *somewhere*: a point may legitimately omit a
  // series (a gap, or a series that starts later). Only a series that appears
  // in no point at all is certainly a mistake — it is what a key typo or a
  // series definition left inside `data` looks like.
  const missing = input.series
    .map((serie) => serie.key)
    .filter((key) => !rows.some((row) => key in row));
  if (missing.length) {
    problems.push(
      `series key(s) ${missing.map((k) => `"${k}"`).join(', ')} do not appear in any data object (fields found: ${Object.keys(rows[0]!).join(', ')})`,
    );
  }

  if (!problems.length) return undefined;

  return [
    `Invalid chart input: ${problems.join('; ')}.`,
    'Expected shape: each entry of `data` is one data point, e.g.',
    `{"${input.xKey}":"<category>", "<series key 1>": <number>, "<series key 2>": <number>}`,
    '— the series keys are the NUMBER fields to plot; series definitions ({key,name,color}) belong in `series`, not in `data`.',
    'Call the tool again with corrected `data`.',
  ].join(' ');
}

/**
 * Donut/pie contract: each slice needs a label and a numeric value.
 *
 * Unlike the xy charts there is no key lookup here, but a malformed slice still
 * renders as a blank legend entry or an empty arc, which reads as a renderer
 * bug rather than a bad tool call.
 */
function donutContractIssues(input: {
  data: Array<{ label?: unknown; value?: unknown }>;
}): string | undefined {
  const rows = input.data ?? [];
  if (rows.length < 2) {
    return `Invalid chart input: at least 2 slices are required, got ${rows.length}. Call the tool again with a corrected \`data\` array.`;
  }
  const bad = rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => !String(row.label ?? '').trim() || typeof row.value !== 'number' || !Number.isFinite(row.value))
    .map(({ index }) => index);
  if (!bad.length) return undefined;

  return [
    `Invalid chart input: slice(s) at index ${bad.join(', ')} are missing a non-empty \`label\` or a numeric \`value\`.`,
    'Expected shape: `data: [{ "label": "<category>", "value": <number>, "color": "<hex>" }, ...]`.',
    'Call the tool again with corrected `data`.',
  ].join(' ');
}

/**
 * Histogram contract: the bin metadata must describe the counts array.
 *
 * The renderer derives the bar positions from `min`, `max` and `bins`, so an
 * unsurveyed range or a bin count that disagrees with `counts` produces a
 * nonsense x-axis rather than an obvious error.
 */
function histogramContractIssues(input: {
  bins: number;
  min: number;
  max: number;
  counts: number[];
}): string | undefined {
  if (!input.counts?.length) {
    return 'Invalid histogram input: `counts` must contain at least one value. Call the tool again with the bin counts for the scanned data.';
  }
  if (!(input.max > input.min)) {
    return `Invalid histogram input: \`max\` (${input.max}) must be greater than \`min\` (${input.min}), because the bin width is derived from that range. Call the tool again with the real value range.`;
  }
  if (input.counts.length !== input.bins) {
    return `Invalid histogram input: \`bins\` is ${input.bins} but \`counts\` has ${input.counts.length} entries; they must be equal, one count per bin. Call the tool again with corrected values.`;
  }
  return undefined;
}

/**
 * Findings contract: every finding needs a label, because the card renders one
 * row per entry and an unlabelled row shows up as an empty line.
 */
function findingsContractIssues(input: {
  findings: Array<{ label?: unknown }>;
}): string | undefined {
  const rows = input.findings ?? [];
  if (!rows.length) {
    return 'Invalid findings input: `findings` must contain at least one entry. Call the tool again with the structured observations.';
  }
  const bad = rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => !String(row.label ?? '').trim())
    .map(({ index }) => index);
  if (!bad.length) return undefined;

  return [
    `Invalid findings input: finding(s) at index ${bad.join(', ')} have no \`label\`.`,
    'Expected shape: `findings: [{ "label": "<observation>", "value": <optional>, "severity": "<optional>" }, ...]`.',
    'Call the tool again with corrected `findings`.',
  ].join(' ');
}

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
      description: [
        'Create a LINE chart for continuous data on an ordered x-axis (time, dates, sequential index).',
        'Pass exactly this shape — a concrete example with two points and one series:',
        '{"title":"Value over time","xKey":"month","series":[{"key":"value","name":"Value","color":"#3b82f6"}],"data":[{"month":"Jan","value":12},{"month":"Feb","value":19}]}',
        'Rules: `xKey` is the field holding the x value and must be present on every data point; each `series[].key` must exist as a field in `data` holding the numbers for that series (a point may omit it when the series has no value there); `data` is a real JSON array (never a JSON string).',
        'Use chart for ordered axes, bar_chart for categories, donut_chart for parts of a whole, area_chart for cumulative magnitude.',
        'Call this tool to show the chart. Never print the chart JSON as text or a code block — only the tool call produces a visible chart.',
      ].join(' '),
      parameters: chartZod,
      skipPermission: true,
      handler: async (input) => {
        const issue = chartContractIssues(input);
        if (issue) return { error: issue };
        return input;
      },
    }),
    defineTool('bar_chart', {
      description: [
        'Create a BAR chart comparing discrete categories (e.g. counts per category).',
        'Pass exactly this shape — a concrete example with two categories and one series:',
        '{"title":"Items by size","xKey":"category","series":[{"key":"count","name":"Items","color":"#3b82f6"}],"data":[{"category":"Small","count":45},{"category":"Large","count":380}]}',
        'Rules: `xKey` is the field holding the category label and must be present on every data point; each `series[].key` must exist as a field in `data` holding the numbers for that series (a point may omit it when the series has no value there); `data` is a real JSON array (never a JSON string); do not repeat the same key across series.',
        'Use bar_chart for categories, chart for ordered/continuous axes, and donut_chart for parts of a whole.',
        'Call this tool to show the chart. Never print the chart JSON as text or a code block — only the tool call produces a visible chart.',
      ].join(' '),
      parameters: barChartZod,
      skipPermission: true,
      handler: async (input) => {
        const issue = chartContractIssues(input);
        if (issue) return { error: issue };
        return input;
      },
    }),
    defineTool('donut_chart', {
      description: [
        'Create a DONUT or PIE chart showing proportions of a single whole (2-8 slices).',
        'Pass exactly this shape:',
        '{"title":"Share by type","data":[{"label":"CT","value":12,"color":"#3b82f6"},{"label":"MR","value":5,"color":"#10b981"}]}',
        '`variant` is "donut" (default) or "pie" — follow the wording the user used. Use bar_chart to compare absolute values instead.',
        'Call this tool to show the chart. Never print the chart JSON as text or a code block — only the tool call produces a visible chart.',
      ].join(' '),
      parameters: donutChartZod,
      skipPermission: true,
      handler: async (input) => {
        const issue = donutContractIssues(input);
        if (issue) return { error: issue };
        return input;
      },
    }),
    defineTool('area_chart', {
      description: [
        'Create an AREA chart for cumulative magnitude or composition over an ordered axis.',
        'Same shape as the line chart: `xKey` names the x field, each `series[].key` must be a numeric field of every `data` object, and `data` is a real JSON array (never a JSON string). Example:',
        '{"title":"Totals","xKey":"month","series":[{"key":"total","name":"Total","color":"#10b981"}],"data":[{"month":"Jan","total":30},{"month":"Feb","total":55}]}',
        'Use `chart` for a plain trend line and bar_chart for categories.',
        'Call this tool to show the chart. Never print the chart JSON as text or a code block — only the tool call produces a visible chart.',
      ].join(' '),
      parameters: areaChartZod,
      skipPermission: true,
      handler: async (input) => {
        const issue = chartContractIssues(input);
        if (issue) return { error: issue };
        return input;
      },
    }),
    defineTool('findings', {
      description: 'Present structured ANALYSIS FINDINGS as a professional findings card. Use after performing ROI measurements, segmentation, volume scans, or any quantitative image analysis. Each finding has a label, optional value, severity level (critical/warning/abnormal/normal/info), and optional detail text. The findings card renders with color-coded severity icons and a summary banner — use it for radiologist-style structured reports. Do NOT dump raw data in text when you could present it as findings.',
      parameters: findingsZod,
      skipPermission: true,
      handler: async (input) => {
        const issue = findingsContractIssues(input);
        if (issue) return { error: issue };
        return input;
      },
    }),
    defineTool('histogram', {
      description: 'Render a PIXEL INTENSITY HISTOGRAM as an interactive bar chart with statistical summary. Use whenever you have histogram data from the frontend bridge (GET /snapshot histogram, POST /roi histogram, or POST /volume scan histogram). Provide bins, min, max, counts array, and optional statistics (mean, median, stddev, min, max). The component renders a professional bar chart with statistics displayed above the bars. Use this instead of printing raw histogram JSON.',
      parameters: histogramZod,
      skipPermission: true,
      handler: async (input) => {
        const issue = histogramContractIssues(input);
        if (issue) return { error: issue };
        return input;
      },
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
  /** Client-facing provider settings (may be the UI-level `ollama` kind). */
  provider?: ProviderConfigClient;
  /** Run the CLI with `COPILOT_OFFLINE=true` (local providers only). */
  offline?: boolean;
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
/**
 * Local models must cold-prefill the title prompt (a fresh session can never
 * reuse a cached prefix), which on consumer hardware takes tens of seconds even
 * for a small prompt. Give them a budget that can actually succeed.
 */
const TITLE_GENERATION_TIMEOUT_LOCAL_MS = 120_000;

type SdkReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;

function reasoningEffortConfig(reasoningEffort?: ReasoningEffortValue): { reasoningEffort?: SdkReasoningEffort } {
  return reasoningEffort
    ? { reasoningEffort: reasoningEffort as SdkReasoningEffort }
    : {};
}

async function getOrCreateSession(args: {
  chatId: string;
  model: string;
  provider?: ProviderConfigClient;
  offline?: boolean;
  reasoningEffort?: ReasoningEffortValue;
  systemMessage: string;
  forceNew?: boolean;
  skillDirectories?: string[];
  disabledSkills?: string[];
}) {
  const client = await getCopilotClientFor(args.provider, args.offline, args.model);
  const cfg = _config;
  const provider = args.provider ? toSdkProvider(args.provider) : undefined;

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
    ...(provider ? { provider } : {}),
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
        ...(provider ? { provider } : {}),
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
        const errorText = error?.message
          ?? 'Tool call rejected before execution: the arguments did not match the tool schema. Call the tool again, passing each parameter as the documented JSON type — `data` must be an actual JSON array of objects, not a JSON-encoded string.';
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

function configFingerprint(model: string, provider?: ProviderConfigClient, offline?: boolean, reasoningEffort?: ReasoningEffortValue, disabledSkills?: string[], skillsSystemFragment?: string): string {
  const skills = disabledSkills?.length ? [...disabledSkills].sort() : null;
  return JSON.stringify({
    model,
    provider: provider ?? null,
    offline: offline ?? false,
    reasoningEffort: reasoningEffort ?? null,
    skills,
    fragment: skillsSystemFragment || null,
  });
}

export async function runChatTurn(args: RunArgs): Promise<Response> {
  const assistantMessageId = crypto.randomUUID();
  const state = newState(assistantMessageId);

  const fingerprint = configFingerprint(args.model, args.provider, args.offline, args.reasoningEffort, args.disabledSkills, args.skillsSystemFragment);
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
    offline: args.offline,
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
  provider?: ProviderConfigClient;
  offline?: boolean;
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
  provider: ProviderConfigClient;
  offline?: boolean;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (args.signal?.aborted) return null;

  const model = resolveTitleLanguageModel(args.model, args.provider);
  if (!model) return null;

  const isLocal = isOllamaProvider(args.provider);

  try {
    const result = await generateText({
      model,
      // A title needs no conversation, no tools and no agent harness. Sending
      // the system prompt as `instructions` (rather than as a system message
      // the provider counts as conversation) keeps the request tiny: the same
      // title through the Copilot CLI costs ~14.5k prompt tokens, because the
      // CLI's own system prompt and tool schemas dominate that path.
      providerOptions: {
        ...titleProviderOptions(args.provider),
        ...(args.provider.type === 'anthropic'
          ? {}
          : {
              openai: {
                instructions: TITLE_SYSTEM_MESSAGE,
                // A title must not spend the local model's slowest resource on a
                // reasoning pass; Ollama honours `effort: "none"` (non-Ollama
                // OpenAI-compatible endpoints simply ignore the field).
                ...(isOllamaProvider(args.provider) ? { reasoning: { effort: 'none' } } : {}),
              },
            }),
      },
      prompt: args.prompt,
      abortSignal: args.signal,
      // A local model still has to prefill even this small prompt from cold, so
      // it needs far more than the remote budget.
      timeout: isLocal ? TITLE_GENERATION_TIMEOUT_LOCAL_MS : TITLE_GENERATION_TIMEOUT_MS,
    });

    return cleanGeneratedChatTitle(result.text);
  } catch {
    return null;
  }
}

async function generateChatTitleWithCopilot(args: {
  chatId: string;
  model: string;
  provider?: ProviderConfigClient;
  offline?: boolean;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const client = await getCopilotClientFor(args.provider, args.offline, args.model);
  const sessionId = `title-${args.chatId}-${crypto.randomUUID()}`;
  const provider = args.provider ? toSdkProvider(args.provider) : undefined;
  const session = await client.createSession({
    sessionId,
    model: args.model,
    streaming: false,
    onPermissionRequest: approveAll,
    workingDirectory: _config.workingDirectory,
    tools: [],
    availableTools: [],
    systemMessage: { content: TITLE_SYSTEM_MESSAGE },
    ...(provider ? { provider } : {}),
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

function resolveTitleLanguageModel(model: string, provider: ProviderConfigClient): LanguageModel | null {
  if (provider.type === 'anthropic') {
    const anthropic = createAnthropic({
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey ?? (provider.bearerToken ? undefined : 'unused'),
      authToken: provider.bearerToken,
      headers: provider.headers,
      name: 'byok-anthropic',
    });
    return anthropic(model);
  }

  // Ollama speaks the OpenAI protocol; it is only a distinct *kind* in the UI.
  if (provider.type === 'openai' || provider.type === 'ollama') {
    const headers = provider.bearerToken
      ? { ...provider.headers, Authorization: `Bearer ${provider.bearerToken}` }
      : provider.headers;
    const openai = createOpenAI({
      baseURL: provider.baseUrl,
      // Ollama ignores the API key, but the OpenAI client requires a value.
      apiKey: provider.apiKey || provider.bearerToken || 'unused',
      headers,
      name: provider.type === 'ollama' ? 'byok-ollama' : 'byok-openai',
    });
    return provider.wireApi === 'responses' ? openai.responses(model) : openai.chat(model);
  }

  return null;
}

function titleProviderOptions(provider: ProviderConfigClient) {
  if (provider.type === 'anthropic') {
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
  // The session may live in any pooled client (default or a local provider's).
  const clients = [_client, ...[..._pool.values()].map((entry) => entry.client)]
    .filter((client): client is CopilotClient => !!client);
  await Promise.all(clients.map(async (client) => {
    try { await client.deleteSession(chatId); } catch { /* ignore */ }
  }));
}

/** List models exposed by the Copilot CLI. Empty array on failure. */
export async function listCopilotModels(): Promise<Array<{ id: string; name: string }>> {
  const result = await getCopilotModelsStatus();
  return result.models;
}

/** A model discovered from a local Ollama server. */
export interface OllamaModelInfo {
  name: string;
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;
  /**
   * Context window the model is *currently loaded with*, not the maximum the
   * model file supports. Ollama's `/api/tags` reports the (often much larger)
   * training-time maximum, so only a running model reports the effective value.
   */
  contextLength?: number;
  capabilities: string[];
}

export interface ModelsStatus {
  models: ModelMetadata[];
  copilot: {
    available: boolean;
    message?: string;
  };
  /** Local Ollama discovery, independent of Copilot auth. */
  ollama: {
    available: boolean;
    version?: string;
    models: OllamaModelInfo[];
    message?: string;
  };
}

/** Kept for existing imports. */
export type CopilotModelsStatus = ModelsStatus;

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

/** Strip the OpenAI-compatible `/v1` suffix to reach Ollama's native API. */
function ollamaNativeBase(baseUrl: string): string {
  return (baseUrl || OLLAMA_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/i, '');
}

async function ollamaFetch(baseUrl: string, path: string, timeoutMs = 3000): Promise<unknown> {
  const response = await fetch(`${ollamaNativeBase(baseUrl)}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Ollama ${path} returned ${response.status}`);
  return await response.json();
}

/**
 * Discover the models a local Ollama server has installed.
 *
 * `/api/tags` is the authoritative installed-model list (with size, parameter
 * count, quantization and capabilities). `/api/ps` is layered on top purely to
 * obtain the effective context length, which is only reported for models that
 * are currently loaded.
 */
export async function discoverOllamaModels(baseUrl: string): Promise<{
  version?: string;
  models: OllamaModelInfo[];
}> {
  const tags = await ollamaFetch(baseUrl, '/api/tags') as { models?: unknown[] };

  // Context length of currently loaded models, keyed by name.
  const runningContext = new Map<string, number>();
  try {
    const ps = await ollamaFetch(baseUrl, '/api/ps') as { models?: unknown[] };
    for (const entry of ps.models ?? []) {
      const row = entry as { name?: string; context_length?: number };
      if (row.name && row.context_length) runningContext.set(row.name, row.context_length);
    }
  } catch {
    // `/api/ps` unavailable — context length simply stays unknown.
  }

  let version: string | undefined;
  try {
    const info = await ollamaFetch(baseUrl, '/api/version') as { version?: string };
    version = info.version;
  } catch {
    // Version is cosmetic.
  }

  const models = (tags.models ?? []).map((entry) => {
    const row = entry as {
      name?: string;
      size?: number;
      details?: { parameter_size?: string; quantization_level?: string };
      capabilities?: string[];
    };
    const name = row.name ?? '';
    return {
      name,
      parameterSize: row.details?.parameter_size,
      quantization: row.details?.quantization_level,
      sizeBytes: row.size,
      contextLength: runningContext.get(name),
      capabilities: row.capabilities ?? [],
    } satisfies OllamaModelInfo;
  }).filter((model) => !!model.name);

  return { version, models };
}

/** Report Copilot model availability plus local Ollama discovery. */
export async function getCopilotModelsStatus(options: { offline?: boolean } = {}): Promise<ModelsStatus> {
  const baseUrl = process.env.OLLAMA_BASE_URL || OLLAMA_BASE_URL;

  // In offline mode the CLI is pinned to a local provider and is deliberately
  // not authenticated with GitHub, so asking it for the Copilot model catalogue
  // can only fail. Skipping the call also avoids spawning a CLI process that
  // will never be used for inference.
  const skipCopilot = options.offline === true;

  const [copilotResult, ollamaResult] = await Promise.allSettled([
    skipCopilot
      ? Promise.reject(new OfflineModeError())
      : (async () => {
          const client = await getCopilotClient();
          return await client.listModels();
        })(),
    discoverOllamaModels(baseUrl),
  ]);

  const copilotOk = copilotResult.status === 'fulfilled';
  const models = copilotOk ? copilotResult.value.map(mapModelInfo) : [];

  if (copilotResult.status === 'rejected' && !(copilotResult.reason instanceof OfflineModeError)) {
    // Not being signed in is a normal state — local-only users never sign in —
    // so it does not deserve an error entry with a stack trace. Real failures
    // (spawn errors, crashes) still do.
    if (isAuthFailure(copilotResult.reason)) {
      console.info('[copilot] not signed in; Copilot-hosted models are unavailable');
    } else {
      console.error('[copilot] listModels failed', copilotResult.reason);
    }
  }

  // When the local server answers, Copilot auth is irrelevant for the user's
  // likely intent, so the message points at the local server instead of login.
  const ollamaAvailable = ollamaResult.status === 'fulfilled';
  const fallbackCopilotMessage = ollamaAvailable
    ? 'GitHub Copilot is not signed in. Local Ollama models are available in Provider Settings.'
    : 'Sign in to GitHub Copilot in your terminal, or enable BYOK provider settings.';

  return {
    models,
    copilot: copilotOk
      ? { available: true }
      : { available: false, message: fallbackCopilotMessage },
    ollama: ollamaAvailable
      ? { available: true, version: ollamaResult.value.version, models: ollamaResult.value.models }
      : {
          available: false,
          models: [],
          message: `No Ollama server responded at ${ollamaBaseForMessage(baseUrl)}.`,
        },
  };
}

/** Distinguishes "not signed in" from real failures (spawn errors, crashes). */
function isAuthFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /not authenticated|authenticate first|unauthoriz|\b401\b/i.test(message);
}

/** Marker for "we intentionally did not ask Copilot", so it is never logged. */
class OfflineModeError extends Error {
  constructor() {
    super('Copilot model listing skipped: offline mode');
    this.name = 'OfflineModeError';
  }
}

function ollamaBaseForMessage(baseUrl: string): string {
  try {
    return new URL(ollamaNativeBase(baseUrl)).host;
  } catch {
    return ollamaNativeBase(baseUrl);
  }
}
