import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    noExternal: [
      '@sveltebase/auth',
      '@sveltebase/i18n',
      '@sveltebase/state',
      '@sveltebase/sync',
      '@sveltebase/utils',
    ],
  },
});
