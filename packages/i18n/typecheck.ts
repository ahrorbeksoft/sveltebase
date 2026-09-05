import { createI18n } from './src/index.js';

const languages = [
  {
    code: 'en',
    label: 'English',
    messages: { title: 'Title', nested: { description: 'Description' } },
  },
  {
    code: 'uz',
    label: 'O‘zbek',
    messages: { title: 'Sarlavha', nested: { description: 'Tavsif' } },
  },
] as const;

const i18n = createI18n({ languages, locale: 'en' });
i18n.t('title');
i18n.t('nested.description');
i18n.locale = 'uz';

// @ts-expect-error literal catalogs reject unknown message keys
i18n.t('missing');
// @ts-expect-error locale assignment is restricted to configured codes
i18n.locale = 'fr';
