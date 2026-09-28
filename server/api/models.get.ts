import { defineEventHandler, getQuery } from 'h3';
import { getCopilotModelsStatus } from '../utils/copilot';

/**
 * Model catalogue for the picker.
 *
 * `offline=true` tells the server the client is in local-only mode, so it must
 * not ask the Copilot CLI for the hosted-model catalogue: in that mode the CLI
 * is deliberately unauthenticated, so the call can only fail — and it would
 * needlessly spawn a CLI process.
 */
export default defineEventHandler(async (event) => {
  const { offline } = getQuery(event);
  return await getCopilotModelsStatus({ offline: offline === 'true' || offline === '1' });
});
