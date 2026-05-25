// Default fallback list shown until /api/models returns. The Copilot CLI
// reports the authoritative list at runtime via `client.listModels()`.
export const FALLBACK_MODELS = [
  { label: 'GPT-5.4', value: 'gpt-5.4', icon: 'i-simple-icons-openai' },
  { label: 'Claude Sonnet 4.5', value: 'claude-sonnet-4.5', icon: 'i-simple-icons-anthropic' },
];

// Kept for backward compatibility with imports elsewhere.
export const MODELS = FALLBACK_MODELS;

export interface ProviderConfigClient {
  type?: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  wireApi?: 'completions' | 'responses';
  headers?: Record<string, string>;
}

export interface ProviderSettings {
  /** When true, requests use BYOK (provider + custom model). */
  byok: boolean;
  provider?: ProviderConfigClient;
  /** Custom model id to send when byok is true. */
  customModel?: string;
  /** Whether the custom provider/model should receive a reasoning effort option. */
  customReasoningEffortEnabled?: boolean;
  /** Preset reasoning effort, or `custom` to use `customReasoningEffort`. */
  customReasoningEffortSelection?: ReasoningEffort | 'custom';
  /** Custom reasoning effort string sent for BYOK requests when `custom` is selected. */
  customReasoningEffort?: string;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningEffortValue = ReasoningEffort | string;

export const GENERIC_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

export interface ModelMetadata {
  id: string;
  name: string;
  contextWindowTokens?: number;
  maxPromptTokens?: number;
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

function iconForModel(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes('claude') || lower.includes('anthropic')) return 'i-simple-icons-anthropic';
  if (lower.includes('gemini') || lower.includes('google')) return 'i-simple-icons-google';
  if (lower.includes('gpt') || lower.includes('openai') || lower.includes('o1') || lower.includes('o3')) return 'i-simple-icons-openai';
  return 'i-lucide-sparkles';
}

export function formatTokenLimit(tokens?: number): string | undefined {
  if (!tokens) return undefined;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return tokens.toLocaleString();
}

export function modelToSelectItem(m: ModelMetadata) {
  const context = formatTokenLimit(m.contextWindowTokens);
  return {
    label: m.name,
    value: m.id,
    icon: iconForModel(m.id),
    description: context ? `Max context size: ${context}` : undefined,
    contextWindowTokens: m.contextWindowTokens,
    maxPromptTokens: m.maxPromptTokens,
    supportsReasoningEffort: m.supportsReasoningEffort,
    supportedReasoningEfforts: m.supportedReasoningEfforts,
    defaultReasoningEffort: m.defaultReasoningEffort,
  };
}
