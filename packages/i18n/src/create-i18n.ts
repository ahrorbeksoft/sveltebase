import { createContext } from "svelte";
import { PersistentState, type StandardSchemaV1 } from "@sveltebase/state";
import type { AppConfig } from "use-intl/core";
import {
  createFormatForLocale,
  createLocaleTranslator,
  getLanguage,
  type FormatOptions,
  type LanguageDefinition
} from "./utils.js";

const DEFAULT_LOCALE_STORAGE_KEY = "locale";

type Cookie = { name: string; value: string };
type MaybeGetter<T> = T | (() => T);
type LocaleSchema<TLocale extends string> = StandardSchemaV1<unknown, TLocale>;
type LocaleState<TLocale extends string> = PersistentState<LocaleSchema<TLocale>>;

export type LocaleCode<TLanguages extends readonly LanguageDefinition[]> =
  TLanguages[number]["code"];

export type CurrentLanguage<TLanguages extends readonly LanguageDefinition[]> =
  TLanguages[number];

export type TranslationValues = Record<string, string | number | Date>;

type Join<TKey extends string, TValue extends string> = `${TKey}.${TValue}`;

type MessageKeys<TMessages> =
  TMessages extends string
    ? never
    : {
        [TKey in Extract<keyof TMessages, string>]:
          TMessages[TKey] extends string
            ? TKey
            : TMessages[TKey] extends Record<string, unknown>
              ? Join<TKey, MessageKeys<TMessages[TKey]>>
              : never;
      }[Extract<keyof TMessages, string>];

type AppConfigMessages =
  AppConfig extends { Messages: infer TMessages }
    ? TMessages
    : never;

export type RegisteredMessages = AppConfigMessages;

export type MessageKey =
  Extract<MessageKeys<RegisteredMessages>, string> extends never
    ? string
    : Extract<MessageKeys<RegisteredMessages>, string>;

export type Translate = <TKey extends MessageKey>(
  key: TKey,
  values?: TranslationValues
) => string;

export type Format = (
  value?: Date | number | string,
  options?: FormatOptions
) => string | undefined;

export interface I18nInstance<TLanguages extends readonly LanguageDefinition[]> {
  readonly languages: TLanguages;
  locale: LocaleCode<TLanguages>;
  readonly currentLanguage: CurrentLanguage<TLanguages>;
  init(cookies?: MaybeGetter<Cookie[] | undefined>): void;
}

type I18nInternal = {
  languages: readonly LanguageDefinition[];
  fallbackLocale: string;
  localeState: LocaleState<string>;
};

const i18nInternals = new WeakMap<object, I18nInternal>();

let getI18nContextBase:
  | (() => I18nInstance<readonly LanguageDefinition[]>)
  | null = null;

let setI18nContextBase:
  | ((
      context: I18nInstance<readonly LanguageDefinition[]>
    ) => I18nInstance<readonly LanguageDefinition[]>)
  | null = null;

function ensureContext() {
  if (!getI18nContextBase || !setI18nContextBase) {
    [getI18nContextBase, setI18nContextBase] =
      createContext<I18nInstance<readonly LanguageDefinition[]>>();
  }

  return {
    get: getI18nContextBase,
    set: setI18nContextBase
  };
}

function getLocaleCodes<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages
) {
  return languages.map((language) => language.code) as LocaleCode<TLanguages>[];
}

function getDefaultLocale<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages
): LocaleCode<TLanguages> {
  const [defaultLocale] = getLocaleCodes(languages);

  if (!defaultLocale) {
    throw new Error("[i18n] createI18n requires at least one language.");
  }

  return defaultLocale;
}

function getI18nInternal<const TLanguages extends readonly LanguageDefinition[]>(
  i18n: I18nInstance<TLanguages>
) {
  const internal = i18nInternals.get(i18n as object);

  if (!internal) {
    throw new Error("[i18n] Internal i18n state was not found for this instance.");
  }

  return {
    languages: internal.languages as TLanguages,
    fallbackLocale: internal.fallbackLocale as LocaleCode<TLanguages>,
    localeState: internal.localeState as LocaleState<LocaleCode<TLanguages>>
  };
}

function getI18nFromContext<const TLanguages extends readonly LanguageDefinition[]>() {
  const { get } = ensureContext();
  return get() as I18nInstance<TLanguages>;
}

export function getTranslations(): Translate {
  const i18n = getI18nFromContext<readonly LanguageDefinition[]>();
  const { languages, fallbackLocale } = getI18nInternal(i18n);

  return ((key: MessageKey, values?: TranslationValues) => {
    const translate = createLocaleTranslator(
      languages,
      i18n.locale,
      fallbackLocale
    ) as (key: string, values?: TranslationValues) => string;

    return translate(key, values);
  }) as Translate;
}

export function getFormat(): Format {
  const i18n = getI18nFromContext<readonly LanguageDefinition[]>();
  const { languages, fallbackLocale } = getI18nInternal(i18n);

  return (value, options) => {
    const format = createFormatForLocale(
      languages,
      i18n.locale,
      fallbackLocale
    );

    return format(value, options);
  };
}

export function createI18n<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages,
  localeStorageKey = DEFAULT_LOCALE_STORAGE_KEY
): I18nInstance<TLanguages> {
  ensureContext();

  const localeCodes = getLocaleCodes(languages);
  const fallbackLocale = getDefaultLocale(languages);

  const localeSchema: LocaleSchema<LocaleCode<TLanguages>> = {
    "~standard": {
      version: 1,
      vendor: "@sveltebase/i18n",
      validate(value) {
        const nextLocale =
          value == null
            ? fallbackLocale
            : typeof value === "string"
              ? (value as LocaleCode<TLanguages>)
              : null;

        if (nextLocale && localeCodes.includes(nextLocale)) {
          return { value: nextLocale };
        }

        return {
          issues: [{ message: `Invalid locale "${String(value)}"` }]
        };
      }
    }
  };

  const localeState = new PersistentState(
    localeStorageKey,
    localeSchema
  ) as LocaleState<LocaleCode<TLanguages>>;

  let initialized = false;

  const i18n: I18nInstance<TLanguages> = {
    get languages() {
      return languages;
    },

    get locale() {
      return localeState.current;
    },

    set locale(nextLocale: LocaleCode<TLanguages>) {
      localeState.current = nextLocale;
    },

    get currentLanguage() {
      return getLanguage(
        languages,
        localeState.current,
        fallbackLocale
      ) as CurrentLanguage<TLanguages>;
    },

    init(cookies?: MaybeGetter<Cookie[] | undefined>) {
      if (!initialized) {
        const resolvedCookies =
          typeof cookies === "function"
            ? (cookies as () => Cookie[] | undefined)()
            : cookies;

        if (resolvedCookies) {
          localeState.init(resolvedCookies);
        }

        initialized = true;
      }

      const { set } = ensureContext();
      set(i18n as I18nInstance<readonly LanguageDefinition[]>);
    }
  };

  i18nInternals.set(i18n as object, {
    languages,
    fallbackLocale,
    localeState: localeState as LocaleState<string>
  });

  return i18n;
}

export type CreateI18nReturn<TLanguages extends readonly LanguageDefinition[]> =
  I18nInstance<TLanguages>;
