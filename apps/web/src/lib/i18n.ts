import { createI18n } from "@sveltebase/i18n";


export const languages = [
  {
    code: "uz", messages: {
      "app-title": "Svelte Essentials",
      "app-description":
        "Workspace paketlarini sinash va namoyish qilish uchun kichik SvelteKit ilova.",

      "language": "Til",
      "current-locale": "Joriy til",

      "i18n-title": "i18n paketi",
      "i18n-description":
        "Context orqali ishlaydigan locale state, tarjima va sana formatlash helperlari.",

      "state-title": "State paketi",
      "state-description": "Svelte runes asosidagi sodda reaktiv state.",

      "utils-title": "Utils paketi",
      "utils-description": "Async jarayonlar, cookie va umumiy helperlar.",

      "counter": "Hisoblagich",
      "increment": "Oshirish",
      "decrement": "Kamaytirish",
      "reset": "Tiklash",

      "format-demo": "Formatlangan sana",
      "async-demo": "Nisbiy vaqt",

      "run-action": "Amalni bajarish",
      "running": "Bajarilmoqda...",
      "async-idle": "Hali async ishga tushmagan.",

      "timestamps-title": "Vaqt belgilari helperi",
      "createdAt": "Yaratilgan vaqt",
      "updatedAt": "Yangilangan vaqt",

      "locale-cookie-title": "Locale cookie",
      "writeCookie": "Cookie yozish",
      "readCookie": "Cookie o‘qish",
      "cookieValue": "Cookie qiymati",

      "just-now": "Hozirgina",
      "minutes-ago": "{minutes} daqiqa oldin",
      "hours-ago": "{hours} soat oldin",
      "days-ago": "{days} kun oldin",
      "weeks-ago": "{weeks} hafta oldin",
      "months-ago": "{months} oy oldin",
      "years-ago": "{years} yil oldin",
      "in-minutes": "{minutes} daqiqadan keyin",
      "in-hours": "{hours} soatdan keyin",
      "in-days": "{days} kundan keyin",
      "in-weeks": "{weeks} haftadan keyin",
      "in-months": "{months} oydan keyin",
      "in-years": "{years} yildan keyin",
      "today-at": "Bugun {time} da",
      "yesterday-at": "Kecha {time} da"
    },
    label: "O‘zbekcha"
  },
  {
    code: "en", messages: {
      "app-title": "Svelte Essentials",
      "app-description":
        "A small SvelteKit app for testing and showcasing the workspace packages.",

      "language": "Language",
      "current-locale": "Current locale",

      "i18n-title": "i18n package",
      "i18n-description":
        "Locale state, translations, and date formatting helpers powered by shared context.",

      "state-title": "State package",
      "state-description": "Simple reactive state powered by Svelte runes.",

      "utils-title": "Utils package",
      "utils-description": "Helpers for async flows, cookies, and general utilities.",

      "counter": "Counter",
      "increment": "Increment",
      "decrement": "Decrement",
      "reset": "Reset",

      "format-demo": "Formatted date",
      "async-demo": "Relative time",

      "run-action": "Run action",
      "running": "Running...",
      "async-idle": "No async work has run yet.",

      "timestamps-title": "Timestamps helper",
      "createdAt": "Created at",
      "updatedAt": "Updated at",

      "locale-cookie-title": "Locale cookie",
      "writeCookie": "Write cookie",
      "readCookie": "Read cookie",
      "cookieValue": "Cookie value",

      "just-now": "Just now",
      "minutes-ago": "{minutes} minutes ago",
      "hours-ago": "{hours} hours ago",
      "days-ago": "{days} days ago",
      "weeks-ago": "{weeks} weeks ago",
      "months-ago": "{months} months ago",
      "years-ago": "{years} years ago",
      "in-minutes": "in {minutes} minutes",
      "in-hours": "in {hours} hours",
      "in-days": "in {days} days",
      "in-weeks": "in {weeks} weeks",
      "in-months": "in {months} months",
      "in-years": "in {years} years",
      "today-at": "Today at {time}",
      "yesterday-at": "Yesterday at {time}"
    },
    label: "English"
  }
] as const;


declare module "use-intl/core" {
  interface AppConfig {
    Messages: typeof languages[1]["messages"];
  }
}

export const i18n = createI18n(languages, "locale");
