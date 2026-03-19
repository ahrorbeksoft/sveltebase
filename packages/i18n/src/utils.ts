import { createFormatter, createTranslator } from "use-intl/core";
import { SvelteDate } from "svelte/reactivity";
import {
  differenceInMinutes,
  format as formatTimeWithDateFns,
  isThisWeek,
  isThisYear,
  isToday,
  isYesterday
} from "date-fns";

export type MessageValue = string | { [key: string]: MessageValue };

export type Messages = {
  [key: string]: MessageValue;
};

export type LanguageDefinition<
  TLocale extends string = string,
  TMessages extends Messages = Messages
> = {
  code: TLocale;
  label: string;
  messages: TMessages;
};

export type FormatOptions = {
  preset?: "default" | "custom" | "birthday" | "month" | "timestring" | "full";
  withTime?: boolean;
};

export const UZ_WEEKDAYS = [
  "Yakshanba",
  "Dushanba",
  "Seshanba",
  "Chorshanba",
  "Payshanba",
  "Juma",
  "Shanba"
] as const;

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

export function getLocaleCodes<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages
) {
  return languages.map((language) => language.code) as TLanguages[number]["code"][];
}

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

export function createLocaleFormatter<TLocale extends string>(locale: TLocale, timeZone = "Asia/Tashkent") {
  return createFormatter({
    locale,
    timeZone,
    now: new SvelteDate()
  });
}

export function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new SvelteDate(value);
}

export function formatTime(value: Date): string {
  return formatTimeWithDateFns(value, "HH:mm");
}

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

export function formatUzMonth(value: Date, withYear: boolean): string {
  return withYear
    ? `${value.getFullYear()}-yil, ${UZ_MONTHS[value.getMonth()]}`
    : UZ_MONTHS[value.getMonth()];
}

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
