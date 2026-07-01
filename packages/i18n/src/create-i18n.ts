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

/**
 * Union of locale codes from a language definition array.
 */
export type LocaleCode<TLanguages extends readonly LanguageDefinition[]> =
  TLanguages[number]["code"];

/**
 * Current language object type from a language definition array.
 */
export type CurrentLanguage<TLanguages extends readonly LanguageDefinition[]> =
  TLanguages[number];

/**
 * Values accepted by translated ICU messages.
 */
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

/**
 * Messages registered through `use-intl` app config augmentation.
 */
export type RegisteredMessages = AppConfigMessages;

/**
 * Dot-separated message key union when message types are registered.
 *
 * Falls back to `string` when no app message type augmentation is present.
 */
export type MessageKey =
  Extract<MessageKeys<RegisteredMessages>, string> extends never
    ? string
    : Extract<MessageKeys<RegisteredMessages>, string>;

/**
 * Translation function returned by `getTranslations`.
 */
export type Translate = <TKey extends MessageKey>(
  key: TKey,
  values?: TranslationValues
) => string;

/**
 * Date/time formatter returned by `getFormat`.
 */
export type Format = (
  value?: Date | number | string,
  options?: FormatOptions
) => string | undefined;

/**
 * Runtime i18n object returned by `createI18n`.
 */
export interface I18nInstance<TLanguages extends readonly LanguageDefinition[]> {
  /** Configured languages and message catalogs. */
  readonly languages: TLanguages;
  /** Current locale code. Assigning this updates persistent locale state. */
  locale: LocaleCode<TLanguages>;
  /** Language definition for the current locale, with fallback handling. */
  readonly currentLanguage: CurrentLanguage<TLanguages>;
  /**
   * Initializes locale state from cookies and installs this instance in Svelte context.
   *
   * Call from a root layout/component before child components call
   * `getTranslations` or `getFormat`.
   */
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

/**
 * Lazily creates the Svelte context pair used by i18n helpers.
 */
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

/**
 * Returns locale codes from language definitions with literal types preserved.
 */
function getLocaleCodes<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages
) {
  return languages.map((language) => language.code) as LocaleCode<TLanguages>[];
}

/**
 * Returns the first configured locale or throws when no languages were provided.
 */
function getDefaultLocale<const TLanguages extends readonly LanguageDefinition[]>(
  languages: TLanguages
): LocaleCode<TLanguages> {
  const [defaultLocale] = getLocaleCodes(languages);

  if (!defaultLocale) {
    throw new Error("[i18n] createI18n requires at least one language.");
  }

  return defaultLocale;
}

/**
 * Reads private i18n internals associated with a public instance.
 */
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

/**
 * Reads the active i18n instance from Svelte context.
 */
function getI18nFromContext<const TLanguages extends readonly LanguageDefinition[]>() {
  const { get } = ensureContext();
  return get() as I18nInstance<TLanguages>;
}

/**
 * Returns a translation function bound to the current i18n context locale.
 *
 * Must be called under an initialized `I18nInstance`.
 */
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

/**
 * Returns a date/time formatter bound to the current i18n context locale.
 *
 * Must be called under an initialized `I18nInstance`.
 */
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

/**
 * Creates a Svelte i18n instance.
 *
 * The first language is used as fallback locale. Locale changes are persisted
 * through `PersistentState` using the provided storage key.
 *
 * @example
 * ```ts
 * export const i18n = createI18n([
 *   { code: "en", label: "English", messages: en },
 *   { code: "uz", label: "O'zbek", messages: uz }
 * ] as const);
 * ```
 */
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
      /**
       * Validates a persisted locale value and falls back when it is missing.
       */
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
        const resolvedCookies =
          typeof cookies === "function"
            ? (cookies as () => Cookie[] | undefined)()
            : cookies;

        if (resolvedCookies) {
          localeState.init(resolvedCookies);
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

/**
 * Return type alias for `createI18n`.
 */
export type CreateI18nReturn<TLanguages extends readonly LanguageDefinition[]> =
  I18nInstance<TLanguages>;
