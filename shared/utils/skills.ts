/**
 * Skill metadata exposed to the front-end.
 */
export interface Skill {
  /** Resolved skill name (frontmatter `name` or directory name). */
  name: string;
  /** Short user-facing description. */
  description: string;
}

/**
 * Server-side skill record — includes the raw markdown body for system-message
 * injection. Not exposed to the client.
 */
export interface SkillFull extends Skill {
  /** Markdown body of SKILL.md, with frontmatter stripped. */
  body: string;
}

/**
 * Skills that should always be passed to the SDK as `disabledSkills`,
 * AND filtered out from the front-end skill list. These are dev-time-only
 * skills that are not relevant to end users (e.g. OpenSpec workflow skills
 * used by IDE-side AI agents).
 */
export const HIDDEN_SKILL_NAMES: readonly string[] = [
  'openspec-propose',
  'openspec-apply-change',
  'openspec-archive-change',
  'openspec-explore',
];

export function isHiddenSkill(name: string): boolean {
  return HIDDEN_SKILL_NAMES.includes(name);
}
