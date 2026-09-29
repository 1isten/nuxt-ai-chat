import { defineEventHandler, getQuery } from 'h3';
import { getCopilotModelsStatus } from '../utils/copilot';

/**
 * Model catalogue for the picker.
 *
 * `offline=true` tells the server the client is in local-only mode, so it must
 * not ask the Copilot CLI for the hosted-model catalogue: in that mode the CLI
 * is deliberately unauthenticated, so the call can only fail — and it would
 * needlessly spawn a CLI process.
 *
 * `ollamaBaseUrl` is the endpoint the client has configured. The server probes
 * *that* address for Ollama models, so a remote (LAN) Ollama server is
 * discovered like a local one. Without it the probe could only ever target the
 * localhost default, which left remote users with an empty model list and a
 * composer that refused to send. Validation happens in
 * `getCopilotModelsStatus()`, which reports an unusable address instead of
 * silently falling back to localhost.
 */
export default defineEventHandler(async (event) => {
  const { offline, ollamaBaseUrl } = getQuery(event);
  return await getCopilotModelsStatus({
    offline: offline === 'true' || offline === '1',
    baseUrl: typeof ollamaBaseUrl === 'string' ? ollamaBaseUrl : undefined,
  });
});
