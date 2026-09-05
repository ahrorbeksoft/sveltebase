import IntlMessageFormat from 'intl-messageformat';

export type MessageValue = string | { readonly [key: string]: MessageValue };
export type Messages = { readonly [key: string]: MessageValue };
export type LanguageDefinition<
  TLocale extends string = string,
  TMessages extends Messages = Messages,
> = {
  readonly code: TLocale;
  readonly label: string;
  readonly messages: TMessages;
};
export type TranslationValues = Record<string, string | number | Date>;
export type FormatOptions = {
  preset?:
    | 'default'
    | 'custom'
    | 'birthday'
    | 'month'
    | 'timestring'
    | 'full'
    | 'relative';
  withTime?: boolean;
  now?: Date;
};
export type Clock = () => Date;
export type Translator = (key: string, values?: TranslationValues) => string;
export type Formatter = (
  value?: Date | number | string,
  options?: FormatOptions,
) => string | undefined;
export type TranslatorOptions = {
  fallbackLocale?: string;
  /** Used after neither active nor fallback catalog contains `key`; defaults to `key`. */
  missingMessage?: string | ((key: string) => string);
};
export type FormatterOptions = TranslatorOptions & {
  /** IANA time zone used for every instant-based preset. Defaults to UTC. */
  timeZone?: string;
  now?: Clock;
};

const UZ_WEEKDAYS = [
  'Yakshanba',
  'Dushanba',
  'Seshanba',
  'Chorshanba',
  'Payshanba',
  'Juma',
  'Shanba',
] as const;
const UZ_MONTHS = [
  'Yanvar',
  'Fevral',
  'Mart',
  'Aprel',
  'May',
  'Iyun',
  'Iyul',
  'Avgust',
  'Sentabr',
  'Oktabr',
  'Noyabr',
  'Dekabr',
] as const;

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function getLocaleCodes<
  const TLanguages extends readonly LanguageDefinition[],
>(languages: TLanguages) {
  return languages.map(
    (language) => language.code,
  ) as TLanguages[number]['code'][];
}

export function validateLanguages<
  const TLanguages extends readonly LanguageDefinition[],
>(languages: TLanguages, fallbackLocale?: string): TLanguages[number]['code'] {
  if (languages.length === 0)
    throw new Error('[i18n] At least one language is required.');
  const seen = new Set<string>();
  for (const language of languages) {
    if (!language.code.trim() || seen.has(language.code)) {
      throw new Error(
        `[i18n] Locale codes must be non-empty and unique (received "${language.code}").`,
      );
    }
    seen.add(language.code);
  }
  const fallback = fallbackLocale ?? languages[0]!.code;
  if (!seen.has(fallback))
    throw new Error(`[i18n] Fallback locale "${fallback}" is not configured.`);
  return fallback as TLanguages[number]['code'];
}

/** Resolves unsupported locale input to the configured fallback. */
export function resolveLocale<
  const TLanguages extends readonly LanguageDefinition[],
>(
  languages: TLanguages,
  locale: string | undefined,
  fallbackLocale?: string,
): TLanguages[number]['code'] {
  const fallback = validateLanguages(languages, fallbackLocale);
  return (languages.find((language) => language.code === locale)?.code ??
    fallback) as TLanguages[number]['code'];
}

export function getLanguage<
  const TLanguages extends readonly LanguageDefinition[],
>(
  languages: TLanguages,
  locale: string | undefined,
  fallbackLocale?: string,
): TLanguages[number] {
  const resolved = resolveLocale(languages, locale, fallbackLocale);
  return languages.find((language) => language.code === resolved)!;
}

function getMessage(messages: Messages, key: string): string | undefined {
  let current: MessageValue | undefined = messages;
  for (const segment of key.split('.')) {
    if (
      !current ||
      typeof current === 'string' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return undefined;
    current = current[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

/** Creates a pure, cached ICU translator for one locale. */
export function createTranslator<
  const TLanguages extends readonly LanguageDefinition[],
>(
  languages: TLanguages,
  locale: string | undefined,
  options: TranslatorOptions = {},
): Translator {
  const fallbackLocale = validateLanguages(languages, options.fallbackLocale);
  const cache = new Map<string, IntlMessageFormat>();
  const active = getLanguage(languages, locale, fallbackLocale);
  const fallback = getLanguage(languages, fallbackLocale, fallbackLocale);
  return (key, values) => {
    const language =
      getMessage(active.messages, key) !== undefined
        ? active
        : getMessage(fallback.messages, key) !== undefined
          ? fallback
          : undefined;
    if (!language)
      return typeof options.missingMessage === 'function'
        ? options.missingMessage(key)
        : (options.missingMessage ?? key);
    const message = getMessage(language.messages, key)!;
    const cacheKey = `${language.code}\u0000${key}`;
    let formatter = cache.get(cacheKey);
    if (!formatter) {
      formatter = new IntlMessageFormat(message, language.code);
      cache.set(cacheKey, formatter);
    }
    const result = formatter.format(values);
    if (Array.isArray(result))
      return (result as unknown[]).map(String).join('');
    return String(result);
  };
}

function validDate(
  value: Date | number | string | undefined,
): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateParts(date: Date, formatter: Intl.DateTimeFormat): DateParts {
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

function civilDay(parts: Pick<DateParts, 'year' | 'month' | 'day'>): number {
  return Math.floor(
    Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000,
  );
}

function timeFormatter(locale: string, timeZone: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function formatUzDate(
  parts: DateParts,
  withYear: boolean,
  withTime: boolean,
  suffix = '',
): string {
  const day = `${parts.day}-${UZ_MONTHS[parts.month - 1]!.toLowerCase()}`;
  let result = withYear ? `${parts.year}-yil, ${day}` : day;
  if (withTime)
    result += `, ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}${suffix}`;
  return result;
}

function relative(date: Date, now: Date, t: Translator): string {
  const difference = date.getTime() - now.getTime();
  const absolute = Math.abs(difference);
  if (absolute < 60_000)
    return difference > 0 ? t('in-minutes', { minutes: 1 }) : t('just-now');
  const future = difference > 0;
  const units: Array<[number, string, string, string]> = [
    [365 * 86_400_000, 'years-ago', 'in-years', 'years'],
    [30 * 86_400_000, 'months-ago', 'in-months', 'months'],
    [7 * 86_400_000, 'weeks-ago', 'in-weeks', 'weeks'],
    [86_400_000, 'days-ago', 'in-days', 'days'],
    [3_600_000, 'hours-ago', 'in-hours', 'hours'],
    [60_000, 'minutes-ago', 'in-minutes', 'minutes'],
  ];
  for (const [milliseconds, pastKey, futureKey, valueName] of units) {
    if (absolute >= milliseconds)
      return t(future ? futureKey : pastKey, {
        [valueName]: Math.floor(absolute / milliseconds),
      });
  }
  return t('just-now');
}

function formatTimeString(
  value: string,
  formatter: Intl.DateTimeFormat,
): string | undefined {
  const match =
    /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)(?::(?<second>[0-5]\d))?$/.exec(
      value,
    );
  if (!match?.groups) return undefined;
  // Time-only strings are wall-clock values, not instants, so UTC prevents an offset shift.
  const date = new Date(
    Date.UTC(
      2000,
      0,
      1,
      Number(match.groups.hour),
      Number(match.groups.minute),
      Number(match.groups.second ?? 0),
    ),
  );
  return formatter.format(date);
}

/** Creates a pure formatter. Formatters cache Intl objects by locale/time zone and read the clock per call. */
export function createFormatter<
  const TLanguages extends readonly LanguageDefinition[],
>(
  languages: TLanguages,
  locale: string | undefined,
  options: FormatterOptions = {},
): Formatter {
  const fallbackLocale = validateLanguages(languages, options.fallbackLocale);
  const resolvedLocale = resolveLocale(languages, locale, fallbackLocale);
  const language = getLanguage(languages, resolvedLocale, fallbackLocale);
  const timeZone = options.timeZone ?? 'UTC';
  const t = createTranslator(languages, resolvedLocale, options);
  const cache = new Map<string, Intl.DateTimeFormat>();
  const partsFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  const wallTimeFormatter = timeFormatter(language.code, 'UTC');
  const getIntl = (key: string, intlOptions: Intl.DateTimeFormatOptions) => {
    let formatter = cache.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(language.code, {
        timeZone,
        ...intlOptions,
      });
      cache.set(key, formatter);
    }
    return formatter;
  };
  const formatTime = (date: Date) =>
    getIntl('time', {
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  return (value, formatOptions = {}) => {
    const preset = formatOptions.preset ?? 'default';
    if (preset === 'timestring' && typeof value === 'string')
      return formatTimeString(value, wallTimeFormatter);
    const date = validDate(value);
    if (!date) return undefined;
    const now = formatOptions.now ?? options.now?.() ?? new Date();
    if (Number.isNaN(now.getTime())) return undefined;
    if (preset === 'relative') return relative(date, now, t);
    const valueParts = dateParts(date, partsFormatter);
    const nowParts = dateParts(now, partsFormatter);
    const thisYear = valueParts.year === nowParts.year;
    const withTime = formatOptions.withTime ?? false;
    const fullDate = {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    } as const;
    const dateWithTime: Intl.DateTimeFormatOptions = withTime
      ? { ...fullDate, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }
      : fullDate;
    if (preset === 'full')
      return language.code === 'uz'
        ? formatUzDate(valueParts, true, withTime)
        : getIntl(`full:${withTime}`, dateWithTime).format(date);
    if (preset === 'birthday')
      return language.code === 'uz'
        ? `${valueParts.year}-yil, ${valueParts.day}-${UZ_MONTHS[valueParts.month - 1]!}`
        : getIntl('birthday', fullDate).format(date);
    if (preset === 'month') {
      if (language.code === 'uz')
        return thisYear
          ? UZ_MONTHS[valueParts.month - 1]!
          : `${valueParts.year}-yil, ${UZ_MONTHS[valueParts.month - 1]!}`;
      return getIntl(
        `month:${thisYear}`,
        thisYear ? { month: 'long' } : { month: 'long', year: 'numeric' },
      ).format(date);
    }
    if (preset === 'custom') {
      if (date.getTime() > now.getTime()) return relative(date, now, t);
      const days = civilDay(nowParts) - civilDay(valueParts);
      const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
      if (minutes < 1) return t('just-now');
      if (minutes < 60) return t('minutes-ago', { minutes });
      if (days === 0) return t('today-at', { time: formatTime(date) });
      if (days === 1) return t('yesterday-at', { time: formatTime(date) });
      const weekday = new Date(
        Date.UTC(valueParts.year, valueParts.month - 1, valueParts.day),
      ).getUTCDay();
      const nowWeekday = new Date(
        Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day),
      ).getUTCDay();
      if (civilDay(valueParts) >= civilDay(nowParts) - ((nowWeekday + 6) % 7)) {
        return language.code === 'uz'
          ? `${UZ_WEEKDAYS[weekday]!}, ${formatTime(date)} da`
          : getIntl('weekday-time', {
              weekday: 'long',
              hour: 'numeric',
              minute: '2-digit',
              hourCycle: 'h23',
            }).format(date);
      }
      return language.code === 'uz'
        ? formatUzDate(valueParts, !thisYear, withTime, ' da')
        : getIntl(
            `custom:${thisYear}:${withTime}`,
            thisYear
              ? {
                  month: 'long',
                  day: 'numeric',
                  ...(withTime
                    ? { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }
                    : {}),
                }
              : dateWithTime,
          ).format(date);
    }
    return language.code === 'uz'
      ? formatUzDate(valueParts, !thisYear, withTime, ' da')
      : getIntl(
          `default:${thisYear}:${withTime}`,
          thisYear
            ? {
                month: 'long',
                day: 'numeric',
                ...(withTime
                  ? { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }
                  : {}),
              }
            : dateWithTime,
        ).format(date);
  };
}
