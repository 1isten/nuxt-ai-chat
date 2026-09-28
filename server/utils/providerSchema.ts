/**
 * Shared validation for the BYOK provider block that the client sends with chat
 * and title requests.
 *
 * `ollama` is a UI-level provider kind. It is validated here and translated to
 * the Copilot SDK's generic `openai` provider type by `toSdkProvider()` before
 * it reaches the SDK — the SDK only understands `openai | azure | anthropic`.
 */
import { z } from 'zod';

export const providerSchema = z.object({
  type: z.enum(['ollama', 'openai', 'anthropic']).optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  bearerToken: z.string().optional(),
  wireApi: z.enum(['completions', 'responses']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).optional();

export type ValidatedProvider = z.infer<typeof providerSchema>;
