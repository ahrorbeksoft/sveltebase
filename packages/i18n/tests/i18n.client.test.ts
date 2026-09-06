import { beforeEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { Cookies } from "@sveltebase/utils";
import { createI18n, getFormat, getTranslations } from "../src/index.js";
import { languages } from "./catalog.js";
import Root from "./Root.svelte";

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
it("requires at least one language", () => {
  expect(() => createI18n([])).toThrow("requires at least one language");
});
it("exposes language definitions and uses the first as fallback", () => {
  const i18n = createI18n(languages);
  expect(i18n.languages).toBe(languages);
  expect(i18n.locale).toBe("en");
  expect(i18n.currentLanguage).toBe(languages[0]);
});
it("translates nested keys and ICU interpolation/plurals without context", () => {
  const i18n = createI18n(languages);
  expect(i18n.t("greeting", { name: "Ada" })).toBe("Hello, Ada");
  expect(i18n.t("nested.title")).toBe("Settings");
  expect(i18n.t("items", { count: 1 })).toBe("1 item");
  expect(i18n.t("items", { count: 3 })).toBe("3 items");
});
it("keeps extracted helpers current after locale changes", () => {
  const i18n = createI18n(languages);
  const { t, format } = i18n;
  i18n.locale = "uz";
  expect(i18n.currentLanguage).toBe(languages[1]);
  expect(t("greeting", { name: "Ada" })).toBe("Salom, Ada");
  expect(format("2020-01-15T12:00:00Z", { preset: "birthday" })).toBe("2020-yil, 15-Yanvar");
});
it("hydrates and persists a custom locale cookie independently", () => {
  Cookies.set("custom-locale", '"uz"');
  const custom = createI18n(languages, "custom-locale");
  const other = createI18n(languages);
  expect(custom.locale).toBe("uz");
  expect(other.locale).toBe("en");
  custom.locale = "en";
  flushSync();
  expect(Cookies.get("custom-locale")).toBe('"en"');
});
it("falls back for invalid persisted locales", () => {
  Cookies.set("locale", '"invalid"');
  expect(createI18n(languages).locale).toBe("en");
});
it("provides reactive translation and format helpers through real component context", async () => {
  const i18n = createI18n(languages);
  const component = mount(Root, { target: document.body, props: { i18n } });
  try {
    flushSync();
    expect(document.querySelector("p")?.textContent).toBe("Hello, Ada");
    i18n.locale = "uz";
    flushSync();
    expect(document.querySelector("p")?.textContent).toBe("Salom, Ada");
    expect(document.querySelector("time")?.textContent).toBe("2020-yil, 15-Yanvar");
  } finally { await unmount(component); }
});
it("requires component initialization for context helpers", () => {
  expect(() => getTranslations()).toThrow();
  expect(() => getFormat()).toThrow();
});
it("falls back when assigned an unknown locale at runtime", () => {
  const i18n = createI18n(languages);
  i18n.locale = "uz";
  i18n.locale = "invalid" as "en";
  expect(i18n.locale).toBe("en");
  expect(i18n.t("greeting", { name: "Ada" })).toBe("Hello, Ada");
});
