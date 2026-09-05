import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
export default ts.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.svelte-kit/**',
      '.implementation/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        document: 'readonly',
        window: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        WebSocket: 'readonly',
        structuredClone: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
      },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    // TypeScript/svelte-check owns symbol resolution, including type-only DOM names.
    rules: { 'no-undef': 'off' },
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
);
