import { defineEventHandler } from 'h3';
import { getCopilotModelsStatus } from '../utils/copilot';

export default defineEventHandler(async () => {
  return await getCopilotModelsStatus();
});
