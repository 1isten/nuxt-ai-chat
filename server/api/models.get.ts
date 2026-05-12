import { defineEventHandler } from 'h3';
import { listCopilotModels } from '../utils/copilot';

export default defineEventHandler(async () => {
  const models = await listCopilotModels();
  return { models };
});
