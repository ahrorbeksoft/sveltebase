import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import {
  createFormatter,
  createTranslator,
  getLanguage,
  resolveLocale,
  validateLanguages,
  type Clock,
  type Formatter,
  type FormatterOptions,
  type LanguageDefinition,
  type Messages,
  type TranslationValues,
  type TranslatorOptions,
} from './core.js';

type Join<TKey extends string, TValue extends string> = `${TKey}.${TValue}`;
type MessageKeys<TMessages> = TMessages extends string
  ? never
  : {
      [TKey in Extract<keyof TMessages, string>]: TMessages[TKey] extends string
        ? TKey
        : TMessages[TKey] extends Messages
          ? Join<TKey, MessageKeys<TMessages[TKey]>>
          : never;
    }[Extract<keyof TMessages, string>];

export type LocaleCode<TLanguages extends readonly LanguageDefinition[]> =
  TLanguages[number]['code'];
export type CurrentLanguage<TLanguages extends readonly LanguageDefinition[]> =
  TLanguages[number];
export type MessageKey<TMessages extends Messages = Messages> =
  string extends keyof TMessages
    ? string
    : Extract<MessageKeys<TMessages>, string>;
export type Translate<TMessages extends Messages = Messages> = <
  TKey extends MessageKey<TMessages>,
>(
  key: TKey,
  values?: TranslationValues,
) => string;
export type Format = Formatter;

/** Optional persistence owned by the application, such as a cookie or local storage adapter. */
export interface LocaleStorage<TLocale extends string = string> {
  get(): string | undefined;
  set(locale: TLocale): void;
}

/** Configuration for one component/request-scoped i18n instance. */
export type CreateI18nOptions<
  TLanguages extends readonly LanguageDefinition[],
> = FormatterOptions & {
  languages: TLanguages;
  locale?: string;
  storage?: LocaleStorage<LocaleCode<TLanguages>>;
};

export interface I18nInstance<
  TLanguages extends readonly LanguageDefinition[],
> {
  readonly languages: TLanguages;
  locale: LocaleCode<TLanguages>;
  readonly currentLanguage: CurrentLanguage<TLanguages>;
  readonly t: Translate<TLanguages[number]['messages']>;
  readonly format: Format;
}

const [getI18nContext, setI18nContext] =
  createContext<I18nInstance<readonly LanguageDefinition[]>>();

class I18n<
  TLanguages extends readonly LanguageDefinition[],
> implements I18nInstance<TLanguages> {
  readonly #locale = new SvelteMap<string, string>();
  readonly #fallbackLocale: LocaleCode<TLanguages>;
  readonly #translatorOptions: TranslatorOptions;
  readonly #formatterOptions: FormatterOptions;
  readonly #storage: LocaleStorage<LocaleCode<TLanguages>> | undefined;
  readonly #translators = new Map<
    string,
    Translate<TLanguages[number]['messages']>
  >();
  readonly #formatters = new Map<string, Formatter>();
  readonly languages: TLanguages;

  constructor(options: CreateI18nOptions<TLanguages>) {
    this.languages = options.languages;
    this.#fallbackLocale = validateLanguages(
      options.languages,
      options.fallbackLocale,
    );
    this.#translatorOptions = {
      fallbackLocale: this.#fallbackLocale,
      ...(options.missingMessage === undefined
        ? {}
        : { missingMessage: options.missingMessage }),
    };
    this.#formatterOptions = {
      ...this.#translatorOptions,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      ...(options.now === undefined ? {} : { now: options.now as Clock }),
    };
    this.#storage = options.storage;
    this.#locale.set(
      'current',
      resolveLocale(
        options.languages,
        options.locale ?? options.storage?.get(),
        this.#fallbackLocale,
      ),
    );
  }

  get locale(): LocaleCode<TLanguages> {
    return this.#locale.get('current') as LocaleCode<TLanguages>;
  }

  set locale(value: LocaleCode<TLanguages>) {
    const locale = resolveLocale(this.languages, value, this.#fallbackLocale);
    if (locale === this.#locale.get('current')) return;
    this.#locale.set('current', locale);
    this.#storage?.set(locale);
  }

  get currentLanguage(): CurrentLanguage<TLanguages> {
    return getLanguage(
      this.languages,
      this.#locale.get('current'),
      this.#fallbackLocale,
    ) as CurrentLanguage<TLanguages>;
  }

  #translator(): Translate<TLanguages[number]['messages']> {
    const locale = this.#locale.get('current')!;
    let translator = this.#translators.get(locale);
    if (!translator) {
      translator = createTranslator(
        this.languages,
        locale,
        this.#translatorOptions,
      ) as Translate<TLanguages[number]['messages']>;
      this.#translators.set(locale, translator);
    }
    return translator;
  }

  #formatter(): Formatter {
    const locale = this.#locale.get('current')!;
    let formatter = this.#formatters.get(locale);
    if (!formatter) {
      formatter = createFormatter(
        this.languages,
        locale,
        this.#formatterOptions,
      );
      this.#formatters.set(locale, formatter);
    }
    return formatter;
  }

  readonly t: Translate<TLanguages[number]['messages']> = ((
    key: MessageKey<TLanguages[number]['messages']>,
    values?: TranslationValues,
  ) => this.#translator()(key, values)) as Translate<
    TLanguages[number]['messages']
  >;

  readonly format: Formatter = (value, options) =>
    this.#formatter()(value, options);
}

/** Creates a reactive i18n instance. Create it per request or root component, never at module scope. */
export function createI18n<
  const TLanguages extends readonly LanguageDefinition[],
>(options: CreateI18nOptions<TLanguages>): I18nInstance<TLanguages> {
  return new I18n(options);
}

/** Places a component/request-scoped instance in Svelte context for descendants. */
export function provideI18n<TLanguages extends readonly LanguageDefinition[]>(
  i18n: I18nInstance<TLanguages>,
): I18nInstance<TLanguages> {
  return setI18nContext(
    i18n as I18nInstance<readonly LanguageDefinition[]>,
  ) as I18nInstance<TLanguages>;
}

/** Gets the i18n instance provided by an ancestor component. */
export function getI18n<
  TLanguages extends readonly LanguageDefinition[] =
    readonly LanguageDefinition[],
>(): I18nInstance<TLanguages> {
  const i18n = getI18nContext();
  if (!i18n)
    throw new Error(
      '[i18n] No instance was provided. Call provideI18n() in an ancestor component.',
    );
  return i18n as I18nInstance<TLanguages>;
}

export function getTranslations<
  TMessages extends Messages = Messages,
>(): Translate<TMessages> {
  return getI18n().t as Translate<TMessages>;
}

export function getFormat(): Format {
  return getI18n().format;
}

export type CreateI18nReturn<TLanguages extends readonly LanguageDefinition[]> =
  I18nInstance<TLanguages>;
