import { expect, it, vi } from "vitest";
import { render } from "svelte/server";
import { createI18n } from "../src/index.js";
import { languages } from "./catalog.js";
import Root from "./Root.svelte";

it("translates without a browser or component context", () => {
  const i18n = createI18n(languages);
  expect(i18n.t("greeting", { name: "Ada" })).toBe("Hello, Ada");
  i18n.locale = "uz";
  expect(i18n.t("greeting", { name: "Ada" })).toBe("Salom, Ada");
});
it.each([false, true])("initializes SSR context from cookies (getter: %s)", (getter) => {
  const i18n = createI18n(languages);
  const locale = '%22uz%22';
  const result = render(Root, { props: { i18n, locale: getter ? () => locale : locale } });
  expect(result.body).toContain("Salom, Ada");
  expect(result.body).toContain("2020-yil, 15-Yanvar");
});
it("supports init with an undefined cookie getter", () => {
  const result = render(Root, { props: { i18n: createI18n(languages), locale: () => undefined } });
  expect(result.body).toContain("Hello, Ada");
});
it("isolates independently created SSR instances", () => {
  const first = createI18n(languages), second = createI18n(languages);
  expect(render(Root, { props: { i18n: first, locale: '"uz"' } }).body).toContain("Salom, Ada");
  expect(render(Root, { props: { i18n: second } }).body).toContain("Hello, Ada");
  expect(first.locale).toBe("uz");
});
it("defaults invalid SSR locale cookies", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = render(Root, { props: { i18n: createI18n(languages), locale: '"xx"' } });
  expect(result.body).toContain("Hello, Ada");
});
it("resets a previously initialized instance when the next locale value is missing", () => {
  const i18n = createI18n(languages);
  expect(render(Root, { props: { i18n, locale: '"uz"' } }).body).toContain("Salom, Ada");
  expect(render(Root, { props: { i18n } }).body).toContain("Hello, Ada");
});
