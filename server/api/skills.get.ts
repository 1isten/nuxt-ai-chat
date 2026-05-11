import { defineEventHandler } from 'h3';
import { discoverVisibleSkills } from '../utils/skills';

export default defineEventHandler(async () => {
  const skills = await discoverVisibleSkills();
  return { skills };
});
