import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFormatForLocale, createLocaleFormatter, createLocaleTranslator, formatTime, formatUzDate, formatUzMonth, getLanguage, getLocaleCodes, toDate, UZ_MONTHS, UZ_WEEKDAYS } from "../src/utils.js";
import type { Translate } from "../src/index.js";
import { languages } from "./catalog.js";

const now = new Date("2026-09-10T10:30:00Z"); // Thursday, 15:30 in Tashkent
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("locale helpers", () => {
  it("extracts codes and resolves the configured fallback", () => {
    expect(getLocaleCodes(languages)).toEqual(["en", "uz"]);
    expect(getLanguage(languages, "uz")).toBe(languages[1]);
    expect(getLanguage(languages, "missing" as "en", "uz")).toBe(languages[1]);
    expect(getLanguage(languages, "missing" as "en")).toBe(languages[0]);
    expect((createLocaleTranslator(languages, "missing" as "en", "uz") as Translate)("greeting", { name: "Ada" })).toBe("Salom, Ada");
  });
  it("supports explicit formatter timezones", () => {
    expect(createLocaleFormatter("en", "UTC").dateTime(now, { hour: "2-digit", minute: "2-digit", hour12: false })).toBe("10:30");
  });
  it("normalizes supported date inputs and preserves Date identity", () => {
    expect(toDate(now)).toBe(now);
    expect(toDate(now.getTime()).getTime()).toBe(now.getTime());
    expect(toDate(now.toISOString()).getTime()).toBe(now.getTime());
  });
  it("formats standalone Uzbek date helpers from local calendar fields", () => {
    const date = new Date(2020, 0, 5, 8, 3);
    expect(formatTime(date)).toBe("08:03");
    expect(formatUzDate(date, false)).toBe("5-yanvar");
    expect(formatUzDate(date, true, true, " da")).toBe("2020-yil, 5-yanvar, 08:03 da");
    expect(formatUzMonth(date, false)).toBe("Yanvar");
    expect(formatUzMonth(date, true)).toBe("2020-yil, Yanvar");
    expect(UZ_MONTHS).toHaveLength(12);
    expect(UZ_WEEKDAYS).toHaveLength(7);
  });
});

describe("relative dates", () => {
  it.each([-59_999, -1, 0, 1, 59_999])("calls sub-minute offset %s just now", (offset) => {
    expect(createFormatForLocale(languages, "en")(new Date(+now + offset), { preset: "relative" })).toBe("Just now");
  });
  it.each([
    [60_000, "1 minutes"], [59 * 60_000, "59 minutes"],
    [3_600_000, "1 hours"], [23 * 3_600_000, "23 hours"],
    [86_400_000, "1 days"], [6 * 86_400_000, "6 days"],
    [7 * 86_400_000, "1 weeks"], [29 * 86_400_000, "4 weeks"],
    [30 * 86_400_000, "1 months"], [364 * 86_400_000, "12 months"],
    [365 * 86_400_000, "1 years"], [730 * 86_400_000, "2 years"]
  ])("formats past and future offset %s", (offset, phrase) => {
    const format = createFormatForLocale(languages, "en");
    expect(format(new Date(+now - offset), { preset: "relative" })).toBe(`${phrase} ago`);
    expect(format(new Date(+now + offset), { preset: "relative" })).toBe(`in ${phrase}`);
  });
});

describe("date presets", () => {
  it.each([undefined, "", 0])("preserves documented empty input %s", (value) => {
    expect(createFormatForLocale(languages, "en")(value)).toBeUndefined();
  });
  it.each(["en", "uz"] as const)("formats every calendar preset in %s", (locale) => {
    const format = createFormatForLocale(languages, locale);
    const date = new Date("2020-01-15T03:04:00Z");
    expect(format(date, { preset: "full" })).toBe(locale === "uz" ? "2020-yil, 15-yanvar" : "January 15, 2020");
    expect(format(date, { preset: "birthday" })).toBe(locale === "uz" ? "2020-yil, 15-Yanvar" : "January 15, 2020");
    expect(format(date, { preset: "month" })).toBe(locale === "uz" ? "2020-yil, Yanvar" : "January 2020");
    expect(format(now, { preset: "month" })).toBe(locale === "uz" ? "Sentabr" : "September");
    expect(format(date, { withTime: true })).toBe(locale === "uz" ? "2020-yil, 15-yanvar, 08:04 da" : "January 15, 2020 at 8:04 AM");
    expect(format(now)).toBe(locale === "uz" ? "10-sentabr" : "September 10");
    expect(format(now, { preset: "full", withTime: true })).toBe(locale === "uz" ? "2026-yil, 10-sentabr, 15:30" : "September 10, 2026 at 3:30 PM");
  });
  it.each(["en", "uz"] as const)("covers custom timeline branches in %s", (locale) => {
    const format = createFormatForLocale(languages, locale);
    const custom = (date: Date | string) => format(date, { preset: "custom", withTime: true });
    expect(custom(new Date(+now - 10_000))).toBe("Just now");
    expect(custom(new Date(+now - 5 * 60_000))).toBe("5 minutes ago");
    expect(custom("2026-09-10T08:00:00Z")).toBe("Today at 13:00");
    expect(custom("2026-09-09T08:00:00Z")).toBe("Yesterday at 13:00");
    expect(custom("2026-09-07T08:00:00Z")).toBe(locale === "uz" ? "Dushanba, 13:00 da" : "Monday 1:00 PM");
    expect(custom("2026-08-01T08:00:00Z")).toBe(locale === "uz" ? "1-avgust, 13:00 da" : "August 1 at 1:00 PM");
    expect(custom("2020-01-15T08:00:00Z")).toBe(locale === "uz" ? "2020-yil, 15-yanvar, 13:00 da" : "January 15, 2020 at 1:00 PM");
    expect(custom(new Date(+now + 2 * 86_400_000))).toBe("in 2 days");
  });
  it("uses the resolved fallback locale for date formatting", () => {
    expect(createFormatForLocale(languages, "missing" as "en", "uz")("2020-01-15T12:00:00Z", { preset: "birthday" })).toBe("2020-yil, 15-Yanvar");
  });
  it("keeps time-only strings independent of the host timezone", () => {
    expect(createFormatForLocale(languages, "en")("08:30:00", { preset: "timestring" })).toBe("8:30 AM");
    expect(createFormatForLocale(languages, "en", "en", "America/New_York")("08:30", { preset: "timestring" })).toBe("8:30 AM");
  });
  it("uses the requested timezone for Uzbek calendar fields and day boundaries", () => {
    const format = createFormatForLocale(languages, "uz", "en", "America/New_York");
    expect(format("2026-09-10T01:00:00Z", { preset: "full", withTime: true })).toBe("2026-yil, 9-sentabr, 21:00");
    expect(format("2026-09-10T01:00:00Z", { preset: "custom" })).toBe("Yesterday at 21:00");
  });
});
it("uses the formatted timezone when deciding whether to omit the year", () => {
  vi.setSystemTime(new Date("2026-12-31T20:00:00Z")); // January 1, 2027 in Tashkent
  const format = createFormatForLocale(languages, "uz");
  expect(format("2026-06-15T00:00:00Z")).toBe("2026-yil, 15-iyun");
  expect(format("2026-12-31T20:00:00Z")).toBe("1-yanvar");
});
it("compares calendar days across a daylight-saving transition", () => {
  vi.setSystemTime(new Date("2026-03-08T16:00:00Z"));
  const format = createFormatForLocale(languages, "en", "en", "America/New_York");
  expect(format("2026-03-07T17:00:00Z", { preset: "custom" })).toBe("Yesterday at 12:00");
  expect(format("2026-03-08T07:30:00Z", { preset: "custom" })).toBe("Today at 03:30");
});
