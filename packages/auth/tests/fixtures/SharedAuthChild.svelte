<script lang="ts">
  import { auth } from './shared-auth.js';
  // This component imports the shared instance; auth is not passed as a prop.
  const initialUser = auth.user;
</script>
<p data-user>{auth.user?.name ?? 'Guest'}</p>
<p data-initial>{initialUser?.id ?? 'none'}</p>
<p data-role>{auth.claims.role ?? 'none'}</p>
<p data-session>{auth.session?.user.id ?? 'none'}</p>
<p data-flat>{auth.sessionUser?.role ?? 'none'}</p>
<p data-ready>{String(auth.isReady)}</p>
<p data-authenticated>{String(auth.isAuthenticated)}</p>
<p data-verifying>{String(auth.isVerifying)}</p>
