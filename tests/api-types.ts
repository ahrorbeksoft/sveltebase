import { expectTypeOf } from "vitest";
import { z } from "zod";
import { PersistentState, State, type InferInput, type InferOutput, type MaybeGetter } from "@sveltebase/state";
import { createAsync, timestamps, type TryCatchReturn } from "@sveltebase/utils";
import { createI18n, type LocaleCode, type CurrentLanguage, type MessageKey, type Format } from "@sveltebase/i18n";
import { languages } from "../packages/i18n/tests/catalog.js";

// Checked by tsc; deliberately not executed (constructors may create effects).
function checkPublicTypes() {
  const schema = z.string().transform((value) => value.length).default(0);
  expectTypeOf<InferInput<typeof schema>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<number>();
  const persistent = new PersistentState("length", schema);
  expectTypeOf(persistent.current).toEqualTypeOf<number>();
  // @ts-expect-error assignments accept the parsed output type
  persistent.current = "wrong";
  const state = new State({ count: 0 });
  expectTypeOf(state.current).toEqualTypeOf<{ count: number }>();
  // @ts-expect-error callback must return the state shape
  state.set(() => "wrong");
  expectTypeOf<MaybeGetter<number>>().toEqualTypeOf<number | (() => number)>();
  expectTypeOf(timestamps(true)).toEqualTypeOf<{ updatedAt: number }>();
  expectTypeOf(timestamps(false)).toEqualTypeOf<{ createdAt: number; updatedAt: number }>();
  const action = createAsync(async (id: number, label: string): Promise<TryCatchReturn> => ({ success: `${id}:${label}` }));
  expectTypeOf(action.run).parameters.toEqualTypeOf<[id: number, label: string]>();
  expectTypeOf(action.error).toEqualTypeOf<Error | null>();
  // @ts-expect-error run preserves task argument types
  action.run("wrong", 1);
  // @ts-expect-error keys are strings
  action.runWithKey(1, 1, "label");
  const i18n = createI18n(languages);
  expectTypeOf(i18n.locale).toEqualTypeOf<"en" | "uz">();
  expectTypeOf<LocaleCode<typeof languages>>().toEqualTypeOf<"en" | "uz">();
  expectTypeOf(i18n.currentLanguage).toEqualTypeOf<CurrentLanguage<typeof languages>>();
  expectTypeOf<MessageKey>().toEqualTypeOf<string>();
  expectTypeOf(i18n.format).toEqualTypeOf<Format>();
  // @ts-expect-error unknown locale rejected at compile time
  i18n.locale = "fr";
  // @ts-expect-error invalid formatting preset
  i18n.format(new Date(), { preset: "invalid" });
}
function checkInitTypes() {
  const state = new PersistentState("value", z.number().default(0));
  state.init("1");
  state.init(() => undefined);
  state.init(null);
  // @ts-expect-error full cookie collections are no longer accepted
  state.init([{ name: "value", value: "1" }]);
  const i18n = createI18n(languages);
  i18n.init('"uz"');
  i18n.init(() => undefined);
  // @ts-expect-error init accepts only the required serialized locale value
  i18n.init([{ name: "locale", value: '"uz"' }]);
}
