import { PersistentState, State } from "@svelte-essentials/state";
import { z } from "zod";
import {
  createLocaleTranslator,
  getLanguage,
  getLocaleCodes,
  type LanguageDefinition
} from "./utils.js";

type LocaleSchema<TLocale extends string> = z.ZodType<TLocale>;
type LocaleState<TLocale extends string> = State<TLocale> | PersistentState<LocaleSchema<TLocale>>;

export interface CreateI18nOptions<
  TLanguages extends readonly LanguageDefinition[],
  TFormat
> {
  languages: TLanguages;
  fallbackLocale: TLanguages[number]["code"];
  signatureLocale?: TLanguages[number]["code"];
  storageKey?: string;
  timeZone?: string;
  createFormat(args: {
    locale: TLanguages[number]["code"];
    fallbackLocale: TLanguages[number]["code"];
    signatureLocale?: TLanguages[number]["code"];
    languages: TLanguages;
    timeZone?: string;
  }): TFormat;
}

export function defineLanguages<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages
) {
  return languages;
}

export function createI18n<const TLanguages extends readonly LanguageDefinition[], TFormat>(
  options: CreateI18nOptions<TLanguages, TFormat>
) {
  const { languages, fallbackLocale, signatureLocale, storageKey, timeZone, createFormat } = options;
  const localeCodes = getLocaleCodes(languages);
  const localeSchema: LocaleSchema<TLanguages[number]["code"]> = z
    .string()
    .transform((value, context) => {
      const nextLocale = (value || fallbackLocale) as TLanguages[number]["code"];

      if (localeCodes.includes(nextLocale)) {
        return nextLocale;
      }

      context.addIssue({
        code: "custom",
        message: `Invalid locale "${String(value)}"`
      });

      return z.NEVER;
    }) as LocaleSchema<TLanguages[number]["code"]>;
  const localeState = (
    storageKey ? new PersistentState(storageKey, localeSchema) : new State(fallbackLocale)
  ) as LocaleState<TLanguages[number]["code"]>;

  function getLocale(locale?: TLanguages[number]["code"]): TLanguages[number]["code"] {
    return locale ?? localeState.current;
  }

  function setLocale(locale: TLanguages[number]["code"]) {
    localeState.current = localeSchema.parse(locale);
  }

  function getTranslations(locale?: TLanguages[number]["code"]) {
    return createLocaleTranslator(languages, getLocale(locale), fallbackLocale);
  }

  function getFormat(locale?: TLanguages[number]["code"]) {
    return createFormat({
      locale: getLocale(locale),
      fallbackLocale,
      signatureLocale,
      languages,
      timeZone
    });
  }

  function getCurrentLanguage(locale?: TLanguages[number]["code"]) {
    return getLanguage(languages, getLocale(locale), fallbackLocale);
  }

  return {
    languages,
    fallbackLocale,
    signatureLocale,
    localeState,
    setLocale,
    getTranslations,
    getFormat,
    getLanguage: getCurrentLanguage
  };
}
