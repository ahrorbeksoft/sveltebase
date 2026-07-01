import { createFormatter, createTranslator, type AppConfig } from "use-intl/core";


import { SvelteDate } from "svelte/reactivity";
/**
 * Returns a date set to local midnight.
 */
function startOfDay(value: Date): Date {
  return new SvelteDate(value.getFullYear(), value.getMonth(), value.getDate());
}

/**
 * Whole-minute difference between two dates.
 */
function differenceInMinutes(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 60_000);
}

/**
 * Checks whether two dates share local year, month, and day.
 */
function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * Checks whether a date is today in the local timezone.
 */
function isToday(value: Date): boolean {
  return isSameDay(value, new SvelteDate());
}

/**
 * Checks whether a date is yesterday in the local timezone.
 */
function isYesterday(value: Date): boolean {
  const yesterday = startOfDay(new SvelteDate());
  yesterday.setDate(yesterday.getDate() - 1);

  return isSameDay(value, yesterday);
}

/**
 * Checks whether a date is in the current local year.
 */
function isThisYear(value: Date): boolean {
  return value.getFullYear() === new SvelteDate().getFullYear();
}

/**
 * Checks whether a date falls inside the current local week.
 *
 * `weekStartsOn` follows `Date#getDay` numbering, where 0 is Sunday and 1 is
 * Monday.
 */
function isThisWeek(value: Date, options?: { weekStartsOn?: number }): boolean {
  const weekStartsOn = options?.weekStartsOn ?? 0;
  const now = new SvelteDate();
  const currentDay = now.getDay();
  const diffToWeekStart = (currentDay - weekStartsOn + 7) % 7;
  const weekStart = startOfDay(now);
  weekStart.setDate(now.getDate() - diffToWeekStart);
  const weekEnd = startOfDay(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  return value >= weekStart && value < weekEnd;
}

/**
 * Minimal internal time formatter for the supported `HH:mm` pattern.
 */
function formatTimeWithDateFns(value: Date, format: string): string {
  if (format !== "HH:mm") {
    throw new Error(`Unsupported format: ${format}`);
  }

  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");

  return `${hours}:${minutes}`;
}

/**
 * Nested translation message value.
 */
export type MessageValue = string | { [key: string]: MessageValue };

/**
 * Translation message tree.
 */
export type Messages = {
  [key: string]: MessageValue;
};

/**
 * Formats a date as a relative phrase using translation keys.
 */
function formatRelativeDate(
  value: Date,
  t: (key: string, values?: Record<string, string | number | Date>) => string
): string {
  const now = new SvelteDate();
  const diffMinutes = Math.floor((value.getTime() - now.getTime()) / 60_000);
  const absMinutes = Math.abs(diffMinutes);

  if (absMinutes < 1) {
    return t("just-now");
  }

  const isFuture = diffMinutes > 0;

  if (absMinutes < 60) {
    return isFuture
      ? t("in-minutes", { minutes: absMinutes })
      : t("minutes-ago", { minutes: absMinutes });
  }

  const absHours = Math.floor(absMinutes / 60);

  if (absHours < 24) {
    return isFuture
      ? t("in-hours", { hours: absHours })
      : t("hours-ago", { hours: absHours });
  }

  const absDays = Math.floor(absHours / 24);

  if (absDays < 7) {
    return isFuture
      ? t("in-days", { days: absDays })
      : t("days-ago", { days: absDays });
  }

  const absWeeks = Math.floor(absDays / 7);

  if (absDays < 30) {
    return isFuture
      ? t("in-weeks", { weeks: absWeeks })
      : t("weeks-ago", { weeks: absWeeks });
  }

  const absMonths = Math.floor(absDays / 30);

  if (absDays < 365) {
    return isFuture
      ? t("in-months", { months: absMonths })
      : t("months-ago", { months: absMonths });
  }

  const absYears = Math.floor(absDays / 365);

  return isFuture
    ? t("in-years", { years: absYears })
    : t("years-ago", { years: absYears });
}

/**
 * One supported language and its message catalog.
 */
export type LanguageDefinition<
  TLocale extends string = string,
  TMessages extends Messages = Messages
> = {
  code: TLocale;
  label: string;
  messages: TMessages;
};

/**
 * Options accepted by locale date/time formatter helpers.
 */
export type FormatOptions = {
  preset?:
    | "default"
    | "custom"
    | "birthday"
    | "month"
    | "timestring"
    | "full"
    | "relative";
  withTime?: boolean;
};

/**
 * Uzbek weekday labels ordered by `Date#getDay`.
 */
export const UZ_WEEKDAYS = [
  "Yakshanba",
  "Dushanba",
  "Seshanba",
  "Chorshanba",
  "Payshanba",
  "Juma",
  "Shanba"
] as const;

/**
 * Uzbek month labels ordered by zero-based month index.
 */
export const UZ_MONTHS = [
  "Yanvar",
  "Fevral",
  "Mart",
  "Aprel",
  "May",
  "Iyun",
  "Iyul",
  "Avgust",
  "Sentabr",
  "Oktabr",
  "Noyabr",
  "Dekabr"
] as const;

/**
 * Returns all locale codes from configured languages.
 */
export function getLocaleCodes<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages
) {
  return languages.map((language) => language.code) as TLanguages[number]["code"][];
}

/**
 * Finds a language by locale, then fallback locale, then first configured language.
 */
export function getLanguage<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages,
  locale: TLanguages[number]["code"],
  fallbackLocale?: TLanguages[number]["code"]
) {
  return (
    languages.find((language) => language.code === locale) ??
    (fallbackLocale ? languages.find((language) => language.code === fallbackLocale) : undefined) ??
    languages[0]
  );
}

/**
 * Creates a `use-intl` translator for one locale.
 */
export function createLocaleTranslator<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages,
  locale: TLanguages[number]["code"],
  fallbackLocale?: TLanguages[number]["code"]
) {
  const language = getLanguage(languages, locale, fallbackLocale);

  return createTranslator({
    locale: language.code,
    messages: language.messages
  });
}

/**
 * Creates a `use-intl` formatter for one locale and timezone.
 */
export function createLocaleFormatter<TLocale extends string>(locale: TLocale, timeZone = "Asia/Tashkent") {
  return createFormatter({
    locale,
    timeZone,
    now: new SvelteDate()
  });
}

/**
 * Normalizes a `Date`, timestamp, or date string into a Date-like SvelteDate.
 */
export function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new SvelteDate(value);
}

/**
 * Formats a date as 24-hour `HH:mm`.
 */
export function formatTime(value: Date): string {
  return formatTimeWithDateFns(value, "HH:mm");
}

/**
 * Formats a date with Uzbek month labels.
 *
 * `suffix` is appended only when `withTime` is enabled.
 */
export function formatUzDate(
  value: Date,
  withYear: boolean,
  withTime = false,
  suffix = ""
): string {
  let text = withYear
    ? `${value.getFullYear()}-yil, ${value.getDate()}-${UZ_MONTHS[value.getMonth()].toLowerCase()}`
    : `${value.getDate()}-${UZ_MONTHS[value.getMonth()].toLowerCase()}`;

  if (withTime) {
    text += `, ${formatTime(value)}${suffix}`;
  }

  return text;
}

/**
 * Formats only month or month with year using Uzbek labels.
 */
export function formatUzMonth(value: Date, withYear: boolean): string {
  return withYear
    ? `${value.getFullYear()}-yil, ${UZ_MONTHS[value.getMonth()]}`
    : UZ_MONTHS[value.getMonth()];
}

/**
 * Creates the high-level formatter used by `getFormat`.
 *
 * Supported presets include default date formatting, relative time, custom
 * timeline labels, month-only labels, birthdays, time strings, and full dates.
 */
export function createFormatForLocale<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages,
  locale: TLanguages[number]["code"],
  fallbackLocale?: TLanguages[number]["code"],
  timeZone = "Asia/Tashkent"
) {
  const formatter = createLocaleFormatter(locale, timeZone);
  const t = createLocaleTranslator(languages, locale, fallbackLocale) as (
    key: string,
    values?: Record<string, string | number | Date>
  ) => string;

  return (value?: Date | number | string, options?: FormatOptions): string | undefined => {
    if (!value) {
      return undefined;
    }

    const preset = options?.preset ?? "default";
    const withTime = options?.withTime ?? false;

    if (typeof value === "string" && preset === "timestring") {
      const [hours = "0", minutes = "0", seconds = "0"] = value.split(":");
      const timeDate = new SvelteDate();
      timeDate.setHours(Number(hours), Number(minutes), Number(seconds), 0);

      return formatter.dateTime(timeDate, {
        hour: "numeric",
        minute: "numeric"
      });
    }

    const date = toDate(value);

    if (preset === "relative") {
      return formatRelativeDate(date, t);
    }

    if (preset === "full") {
      return locale === "uz"
        ? formatUzDate(date, true, withTime)
        : formatter.dateTime(date, {
            year: "numeric",
            month: "long",
            day: "numeric",
            ...(withTime ? { hour: "numeric", minute: "numeric" } : {})
          });
    }

    if (preset === "custom") {
      const now = new SvelteDate();
      const diffMinutes = differenceInMinutes(now, date);

      if (diffMinutes < 1) return t("just-now");
      if (diffMinutes < 60) return t("minutes-ago", { minutes: diffMinutes });
      if (isToday(date)) return t("today-at", { time: formatTime(date) });
      if (isYesterday(date)) return t("yesterday-at", { time: formatTime(date) });

      if (isThisWeek(date, { weekStartsOn: 1 })) {
        return locale === "uz"
          ? `${UZ_WEEKDAYS[date.getDay()]}, ${formatTime(date)} da`
          : formatter.dateTime(date, {
              weekday: "long",
              hour: "numeric",
              minute: "numeric"
            });
      }

      if (isThisYear(date)) {
        return locale === "uz"
          ? formatUzDate(date, false, withTime, " da")
          : formatter.dateTime(date, {
              month: "long",
              day: "numeric",
              ...(withTime ? { hour: "numeric", minute: "numeric" } : {})
            });
      }

      return locale === "uz"
        ? formatUzDate(date, true, withTime, " da")
        : formatter.dateTime(date, {
            year: "numeric",
            month: "long",
            day: "numeric",
            ...(withTime ? { hour: "numeric", minute: "numeric" } : {})
          });
    }

    if (preset === "month") {
      if (isThisYear(date)) {
        return locale === "uz"
          ? formatUzMonth(date, false)
          : formatter.dateTime(date, { month: "long" });
      }

      return locale === "uz"
        ? formatUzMonth(date, true)
        : formatter.dateTime(date, { month: "long", year: "numeric" });
    }

    if (preset === "birthday") {
      return locale === "uz"
        ? `${date.getFullYear()}-yil, ${date.getDate()}-${UZ_MONTHS[date.getMonth()]}`
        : formatter.dateTime(date, {
            year: "numeric",
            month: "long",
            day: "numeric"
          });
    }

    if (isThisYear(date)) {
      return locale === "uz"
        ? formatUzDate(date, false, withTime, " da")
        : formatter.dateTime(date, {
            month: "long",
            day: "numeric",
            ...(withTime ? { hour: "numeric", minute: "numeric" } : {})
          });
    }

    return locale === "uz"
      ? formatUzDate(date, true, withTime, " da")
      : formatter.dateTime(date, {
          year: "numeric",
          month: "long",
          day: "numeric",
          ...(withTime ? { hour: "numeric", minute: "numeric" } : {})
        });
  };
}
