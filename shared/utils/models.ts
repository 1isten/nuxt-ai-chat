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
}

function iconForModel(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes('claude') || lower.includes('anthropic')) return 'i-simple-icons-anthropic';
  if (lower.includes('gemini') || lower.includes('google')) return 'i-simple-icons-google';
  if (lower.includes('gpt') || lower.includes('openai') || lower.includes('o1') || lower.includes('o3')) return 'i-simple-icons-openai';
  return 'i-lucide-sparkles';
}

export function modelToSelectItem(m: { id: string; name: string }) {
  return { label: m.name, value: m.id, icon: iconForModel(m.id) };
}
