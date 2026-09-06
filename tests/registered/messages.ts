import { expectTypeOf } from "vitest";
import { createI18n, type MessageKey, type RegisteredMessages } from "@sveltebase/i18n";

type Catalog = { greeting: string; settings: { title: string; account: { name: string } } };
declare module "use-intl/core" { interface AppConfig { Messages: Catalog } }
expectTypeOf<MessageKey>().toEqualTypeOf<"greeting" | "settings.title" | "settings.account.name">();
expectTypeOf<RegisteredMessages>().toEqualTypeOf<Catalog>();
function checkRegisteredKeys() {
  const i18n = createI18n([{ code: "en", label: "English", messages: { greeting: "Hi", settings: { title: "Settings", account: { name: "Name" } } } }] as const);
  i18n.t("settings.account.name");
  // @ts-expect-error intermediate objects are not translation keys
  i18n.t("settings");
  // @ts-expect-error unknown message key
  i18n.t("missing");
}
