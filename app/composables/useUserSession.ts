import { ref, computed } from 'vue';

/**
 * Stub replacing `useUserSession` from `nuxt-auth-utils`.
 *
 * The server-side session resolver in `server/utils/auth.ts` returns a single
 * local user; this composable mirrors that on the client so existing
 * components compile and render without auth flows.
 */
interface SessionUser {
  id: string;
  username: string;
  name?: string;
  avatar?: string;
  avatarUrl?: string;
}

export function useUserSession() {
  const user = useState<SessionUser>('user-session', () => ({
    id: 'local-user',
    username: 'local',
    name: 'Local User',
  }));

  const loggedIn = computed(() => true);
  const ready = ref(true);

  async function fetch() {
    // no-op
  }

  async function clear() {
    // no-op
  }

  function openInPopup(_url: string) {
    // no-op; auth popup is disabled
  }

  return {
    loggedIn,
    user,
    session: user,
    ready,
    fetch,
    clear,
    openInPopup,
  };
}
