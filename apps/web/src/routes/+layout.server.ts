import { languages } from '$lib/i18n';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ cookies }) => {
  const locale = cookies.get('locale');
  return {
    locale: languages.some((language) => language.code === locale)
      ? locale
      : languages[0].code,
  };
};
