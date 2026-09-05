import { describe, expect, it } from 'vitest';
import {
  createFormatter,
  createI18n,
  createTranslator,
  getLanguage,
  getLocaleCodes,
  resolveLocale,
  validateLanguages,
} from './src/index.js';

const languages = [
  {
    code: 'en',
    label: 'English',
    messages: {
      'just-now': 'just now',
      'minutes-ago': '{minutes} minutes ago',
      'in-minutes': 'in {minutes} minutes',
      'hours-ago': '{hours} hours ago',
      'in-hours': 'in {hours} hours',
      'days-ago': '{days} days ago',
      'in-days': 'in {days} days',
      'weeks-ago': '{weeks} weeks ago',
      'in-weeks': 'in {weeks} weeks',
      'months-ago': '{months} months ago',
      'in-months': 'in {months} months',
      'years-ago': '{years} years ago',
      'in-years': 'in {years} years',
      'today-at': 'Today at {time}',
      'yesterday-at': 'Yesterday at {time}',
      nested: { active: 'Active' },
    },
  },
  {
    code: 'uz',
    label: "O'zbek",
    messages: {
      'just-now': 'Hozirgina',
      'minutes-ago': '{minutes} daqiqa oldin',
      'in-minutes': '{minutes} daqiqadan keyin',
      'hours-ago': '{hours} soat oldin',
      'in-hours': '{hours} soatdan keyin',
      'days-ago': '{days} kun oldin',
      'in-days': '{days} kundan keyin',
      'weeks-ago': '{weeks} hafta oldin',
      'in-weeks': '{weeks} haftadan keyin',
      'months-ago': '{months} oy oldin',
      'in-months': '{months} oydan keyin',
      'years-ago': '{years} yil oldin',
      'in-years': '{years} yildan keyin',
      'today-at': 'Bugun {time}',
      'yesterday-at': 'Kecha {time}',
    },
  },
] as const;

describe('pure i18n helpers', () => {
  it('uses a fallback catalog before its configured missing-message result', () => {
    const translate = createTranslator(languages, 'uz', {
      missingMessage: (key) => `missing:${key}`,
    });
    expect(translate('nested.active')).toBe('Active');
    expect(translate('nested.missing')).toBe('missing:nested.missing');
    expect(createTranslator(languages, 'en')('missing')).toBe('missing');
  });

  it('rejects empty or duplicate language definitions', () => {
    expect(() => validateLanguages([])).toThrow('At least one language');
    expect(() =>
      validateLanguages([
        { code: 'en', label: 'English', messages: {} },
        { code: 'en', label: 'English', messages: {} },
      ]),
    ).toThrow('unique');
    expect(() => validateLanguages(languages, 'missing')).toThrow(
      'not configured',
    );
    expect(getLocaleCodes(languages)).toEqual(['en', 'uz']);
    expect(resolveLocale(languages, 'missing')).toBe('en');
    expect(getLanguage(languages, 'missing').code).toBe('en');
  });

  it('accepts epoch zero, rejects invalid dates, and uses the supplied time zone', () => {
    const formatter = createFormatter(languages, 'uz', {
      timeZone: 'Asia/Tashkent',
    });
    expect(
      formatter(0, { preset: 'full', now: new Date('2026-01-01T00:00:00Z') }),
    ).toBe('1970-yil, 1-yanvar');
    expect(formatter('not-a-date')).toBeUndefined();
    expect(
      formatter(new Date('2026-01-01T18:30:00Z'), {
        preset: 'full',
        withTime: true,
        now: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toContain('23:30');
  });

  it('handles sub-minute and future values without producing a past label', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const formatter = createFormatter(languages, 'en', {
      timeZone: 'UTC',
      now: () => now,
    });
    expect(
      formatter(new Date('2026-01-01T11:59:30Z'), { preset: 'relative' }),
    ).toBe('just now');
    expect(
      formatter(new Date('2026-01-01T12:02:00Z'), { preset: 'relative' }),
    ).toBe('in 2 minutes');
    expect(
      formatter(new Date('2026-01-01T12:02:00Z'), { preset: 'custom' }),
    ).toBe('in 2 minutes');
    expect(
      formatter(new Date('2026-01-01T12:00:30Z'), { preset: 'relative' }),
    ).toBe('in 1 minutes');
  });

  it('uses zone-aware calendar boundaries and every date preset', () => {
    const now = new Date('2026-03-09T06:30:00Z');
    const eastern = createFormatter(languages, 'en', {
      timeZone: 'America/New_York',
      now: () => now,
    });
    const uzbek = createFormatter(languages, 'uz', {
      timeZone: 'Asia/Tashkent',
      now: () => new Date('2026-06-10T12:00:00Z'),
    });
    const weekly = createFormatter(languages, 'en', {
      timeZone: 'America/New_York',
      now: () => new Date('2026-03-15T16:00:00Z'),
    });

    expect(
      eastern(new Date('2026-03-08T06:30:00Z'), {
        preset: 'full',
        withTime: true,
      }),
    ).toContain('March 8, 2026');
    expect(
      eastern(new Date('2026-03-09T04:00:00Z'), { preset: 'custom' }),
    ).toContain('Today at');
    expect(
      eastern(new Date('2026-03-09T03:30:00Z'), { preset: 'custom' }),
    ).toContain('Yesterday at');
    expect(
      weekly(new Date('2026-03-13T17:00:00Z'), { preset: 'custom' }),
    ).toContain('Friday');
    expect(
      eastern(new Date('2025-12-31T12:00:00Z'), { preset: 'default' }),
    ).toContain('2025');
    expect(
      eastern(new Date('2026-02-01T12:00:00Z'), { preset: 'month' }),
    ).toContain('February');
    expect(
      eastern(new Date('2000-02-01T12:00:00Z'), { preset: 'birthday' }),
    ).toContain('2000');
    expect(
      uzbek(new Date('2026-06-10T18:30:00Z'), {
        preset: 'default',
        withTime: true,
      }),
    ).toBe('10-iyun, 23:30 da');
    expect(uzbek(new Date('2026-06-01T12:00:00Z'), { preset: 'month' })).toBe(
      'Iyun',
    );
    expect(
      uzbek(new Date('2000-02-01T12:00:00Z'), { preset: 'birthday' }),
    ).toBe('2000-yil, 1-Fevral');
  });

  it('only accepts complete time-only strings', () => {
    const formatter = createFormatter(languages, 'en');
    expect(formatter('08:30:00', { preset: 'timestring' })).toBeTruthy();
    expect(formatter('29:61', { preset: 'timestring' })).toBeUndefined();
    expect(formatter(undefined, { preset: 'timestring' })).toBeUndefined();
  });
});

describe('createI18n', () => {
  it('keeps locale state local to its instance and persists only through its injected adapter', () => {
    const persisted: string[] = [];
    const first = createI18n({
      languages,
      locale: 'en',
      storage: {
        get: () => undefined,
        set: (locale) => persisted.push(locale),
      },
    });
    const second = createI18n({ languages, locale: 'uz' });
    first.locale = 'en';
    expect(persisted).toEqual([]);
    first.locale = 'uz';
    expect(first.t('just-now')).toBe('Hozirgina');
    expect(second.t('just-now')).toBe('Hozirgina');
    expect(persisted).toEqual(['uz']);
  });

  it('hydrates from injected storage and falls back safely', () => {
    const fromStorage = createI18n({
      languages,
      storage: { get: () => 'uz', set: () => undefined },
      missingMessage: '—',
      timeZone: 'UTC',
    });
    const unsupported = createI18n({ languages, locale: 'missing' });
    expect(fromStorage.currentLanguage.code).toBe('uz');
    expect(fromStorage.t('missing')).toBe('—');
    expect(unsupported.currentLanguage.code).toBe('en');
    expect(fromStorage.format('not-a-date')).toBeUndefined();
  });
});
