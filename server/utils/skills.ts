import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Skill, SkillFull } from '../../shared/utils/skills';
import { HIDDEN_SKILL_NAMES } from '../../shared/utils/skills';

/**
 * Repo-level directory containing skills as immediate subdirectories.
 * Override at runtime via the `SKILLS_DIR` env var (e.g. point it at the
 * Electron app's resources folder).
 */
export const SKILLS_DIR = process.env.SKILLS_DIR
  ? path.resolve(process.env.SKILLS_DIR)
  : path.resolve(process.cwd(), '.github/skills');

interface CachedSkills {
  list: SkillFull[];
  /**
   * Fingerprint of everything the cached list was built from: the `SKILLS_DIR`
   * mtime (skill folders added/removed) plus each `SKILL.md`'s mtime and size.
   */
  signature: string;
}

let _cache: CachedSkills | null = null;

/**
 * Cheap fingerprint of the skills on disk.
 *
 * Watching only `SKILLS_DIR`'s own mtime is not enough: editing an existing
 * `SKILL.md` changes the *file's* mtime, not the parent directory's, so a
 * cached body would keep being injected into the system message until the
 * server was restarted. Since that body is inlined verbatim by
 * `renderSkillsSystemMessage`, a stale cache silently feeds the model the old
 * instructions — the worst possible failure mode for a style/workflow skill.
 *
 * Collecting these stats costs one `stat` per skill, which is negligible
 * against the cost of the request that follows.
 */
async function skillsSignature(dirNames: string[]): Promise<string> {
  const parts = await Promise.all(
    dirNames.map(async (name) => {
      try {
        const stat = await fs.stat(path.join(SKILLS_DIR, name, 'SKILL.md'));
        return `${name}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${name}:missing`;
      }
    }),
  );
  return parts.sort().join('|');
}

/**
 * Minimal YAML frontmatter parser. Only extracts top-level `key: value` pairs
 * separated by `\n` between two `---` markers. Strips matching surrounding
 * quotes. Sufficient for SKILL.md frontmatter.
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: raw };
  const fm = match[1]!;
  const body = raw.slice(match[0].length);
  const meta: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    meta[m[1]!] = value;
  }
  return { meta, body };
}

async function readSkill(dirPath: string, dirName: string): Promise<SkillFull | null> {
  const skillFile = path.join(dirPath, 'SKILL.md');
  try {
    const raw = await fs.readFile(skillFile, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return {
      name: meta.name?.trim() || dirName,
      description: meta.description?.trim() || '',
      body: body.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Discover all skills in the repo's `.github/skills/` directory.
 * Result is cached until a skill folder is added/removed *or* any existing
 * `SKILL.md` changes — see `skillsSignature`.
 */
export async function discoverSkills(): Promise<SkillFull[]> {
  let entries;
  try {
    entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const signature = await skillsSignature(dirNames);

  if (_cache && _cache.signature === signature) {
    return _cache.list;
  }

  const skills: SkillFull[] = [];
  for (const dirName of dirNames) {
    const skill = await readSkill(path.join(SKILLS_DIR, dirName), dirName);
    if (skill) skills.push(skill);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  _cache = { list: skills, signature };
  return skills;
}

/**
 * Subset of skills that are visible to end users (i.e. not in HIDDEN_SKILL_NAMES).
 * Returned without the `body` field for client safety.
 */
export async function discoverVisibleSkills(): Promise<Skill[]> {
  const all = await discoverSkills();
  return all
    .filter((s) => !HIDDEN_SKILL_NAMES.includes(s.name))
    .map(({ name, description }) => ({ name, description }));
}

/**
 * Build a system-message fragment that eagerly injects the body of each
 * enabled skill. Returns an empty string if no skills are enabled.
 *
 * The SDK's `skillDirectories` option only makes skills available as tools
 * for the model to invoke on demand — it does not auto-inject content. For
 * a reliable propose-first / style-guide workflow, we inline the bodies into
 * the system message ourselves.
 */
export function renderSkillsSystemMessage(enabled: SkillFull[]): string {
  if (enabled.length === 0) return '';
  const sections = enabled.map((s) =>
    `<skill name="${s.name}">\n${s.body}\n</skill>`,
  ).join('\n\n');
  return `The following skills are ACTIVE for this conversation. You MUST follow their instructions exactly. Skill instructions take precedence over your default behavior when they conflict.\n\n${sections}`;
}
