import type { Skill } from '#shared/utils/skills';

/**
 * Manages the catalog of available skills and the user's enabled set.
 *
 * - The catalog is fetched once from /api/skills (already filtered to exclude
 *   hidden / dev-only skills).
 * - `enabledSkills` is a localStorage-backed array of skill names the user has
 *   opted in to. New skills are disabled by default.
 */
export function useSkills() {
  const skills = useState<Skill[]>('skills', () => []);
  const loaded = useState<boolean>('skills-loaded', () => false);

  const enabledSkills = useLocalStorage<string[]>('enabledSkills', []);

  async function refreshSkills() {
    try {
      const res = await $fetch<{ skills: Skill[] }>('/api/skills');
      skills.value = res.skills ?? [];
      loaded.value = true;
      // Drop any enabled names that no longer exist in the catalog.
      const known = new Set(skills.value.map((s) => s.name));
      enabledSkills.value = enabledSkills.value.filter((n) => known.has(n));
    } catch (err) {
      console.warn('[useSkills] failed to load /api/skills', err);
    }
  }

  function isEnabled(name: string): boolean {
    return enabledSkills.value.includes(name);
  }

  function toggle(name: string, value?: boolean) {
    const want = value ?? !isEnabled(name);
    if (want) {
      if (!enabledSkills.value.includes(name)) {
        enabledSkills.value = [...enabledSkills.value, name];
      }
    } else {
      enabledSkills.value = enabledSkills.value.filter((n) => n !== name);
    }
  }

  const enabledCount = computed(() => enabledSkills.value.length);

  return {
    skills,
    loaded,
    enabledSkills,
    enabledCount,
    isEnabled,
    toggle,
    refreshSkills,
  };
}
