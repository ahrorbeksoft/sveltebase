import { mount, unmount } from 'svelte';
import { describe, expect, it } from 'vitest';
import { createI18n } from './src/index.js';
import ContextProbe from './context-probe.svelte';

describe('browser i18n instances', () => {
  it('keeps reactive locale state local to each instance', () => {
    const languages = [
      { code: 'en', label: 'English', messages: { title: 'English' } },
      { code: 'uz', label: "O'zbek", messages: { title: "O'zbek" } },
    ] as const;
    const first = createI18n({ languages, locale: 'en' });
    const second = createI18n({ languages, locale: 'uz' });
    first.locale = 'en';
    expect(first.currentLanguage.code).toBe('en');
    expect(second.currentLanguage.code).toBe('uz');
  });

  it('retrieves the request-scoped instance through Svelte context', () => {
    const languages = [
      { code: 'en', label: 'English', messages: { 'just-now': 'Just now' } },
    ] as const;
    const target = document.createElement('div');
    let captured: ReturnType<typeof createI18n<typeof languages>> | undefined;
    const component = mount(ContextProbe, {
      target,
      props: {
        languages,
        locale: 'en',
        capture: (i18n) => (captured = i18n as typeof captured),
      },
    });
    expect(captured?.t('just-now')).toBe('Just now');
    unmount(component);
  });
});
