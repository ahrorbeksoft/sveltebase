export const languages = [
  {
    code: 'uz',
    messages: {
      'app-title': 'Svelte Essentials',
      'app-description':
        'Workspace paketlarini sinash va namoyish qilish uchun kichik SvelteKit ilova.',

      language: 'Til',
      'current-locale': 'Joriy til',

      'i18n-title': 'i18n paketi',
      'i18n-description':
        'Context orqali ishlaydigan locale state, tarjima va sana formatlash helperlari.',

      'state-title': 'State paketi',
      'state-description': 'Svelte runes asosidagi sodda reaktiv state.',

      'utils-title': 'Utils paketi',
      'utils-description': 'Async jarayonlar, cookie va umumiy helperlar.',

      'auth-title': 'Auth paketi',
      'auth-description':
        'Sync yoki browser storage talab qilmaydigan HTTP auth client.',
      'auth-demo-note':
        'Bu demo tarmoq o‘rniga inject qilingan fetch stubdan foydalanadi.',
      'auth-login': 'Demo login',
      'auth-logout': 'Logout',
      'auth-signed-out': 'Tizimga kirmagan',
      'auth-signed-in': 'Tizimga kirdi',

      'sync-title': 'Sync paketi',
      'sync-description':
        'Offline o‘zgarishlarni tasdiqlanmaguncha outboxda saqlaydigan explicit mutation API.',
      'sync-offline-note':
        'Bu demo local IndexedDBga yozadi; transport ataylab ishga tushirilmagan.',
      'sync-queue-mutation': 'Offline o‘zgarishni navbatga qo‘yish',
      'sync-pending': 'Kutilayotgan o‘zgarishlar',

      'state-demo-title': 'Reaktiv state',
      'utils-demo-title': 'Async helper',

      counter: 'Hisoblagich',
      increment: 'Oshirish',
      decrement: 'Kamaytirish',
      reset: 'Tiklash',

      'format-demo': 'Formatlangan sana',
      'async-demo': 'Nisbiy vaqt',

      'run-action': 'Amalni bajarish',
      running: 'Bajarilmoqda...',
      'async-idle': 'Hali async ishga tushmagan.',

      'timestamps-title': 'Vaqt belgilari helperi',
      createdAt: 'Yaratilgan vaqt',
      updatedAt: 'Yangilangan vaqt',

      'locale-cookie-title': 'Locale cookie',
      writeCookie: 'Cookie yozish',
      readCookie: 'Cookie o‘qish',
      cookieValue: 'Cookie qiymati',

      'just-now': 'Hozirgina',
      'minutes-ago': '{minutes} daqiqa oldin',
      'hours-ago': '{hours} soat oldin',
      'days-ago': '{days} kun oldin',
      'weeks-ago': '{weeks} hafta oldin',
      'months-ago': '{months} oy oldin',
      'years-ago': '{years} yil oldin',
      'in-minutes': '{minutes} daqiqadan keyin',
      'in-hours': '{hours} soatdan keyin',
      'in-days': '{days} kundan keyin',
      'in-weeks': '{weeks} haftadan keyin',
      'in-months': '{months} oydan keyin',
      'in-years': '{years} yildan keyin',
      'today-at': 'Bugun {time} da',
      'yesterday-at': 'Kecha {time} da',
    },
    label: 'O‘zbekcha',
  },
  {
    code: 'en',
    messages: {
      'app-title': 'Svelte Essentials',
      'app-description':
        'A small SvelteKit app for testing and showcasing the workspace packages.',

      language: 'Language',
      'current-locale': 'Current locale',

      'i18n-title': 'i18n package',
      'i18n-description':
        'Locale state, translations, and date formatting helpers powered by shared context.',

      'state-title': 'State package',
      'state-description': 'Simple reactive state powered by Svelte runes.',

      'utils-title': 'Utils package',
      'utils-description':
        'Helpers for async flows, cookies, and general utilities.',

      'auth-title': 'Auth package',
      'auth-description':
        'An HTTP auth client that does not require sync or browser storage.',
      'auth-demo-note':
        'This demo uses an injected fetch stub instead of a network request.',
      'auth-login': 'Demo login',
      'auth-logout': 'Logout',
      'auth-signed-out': 'Signed out',
      'auth-signed-in': 'Signed in',

      'sync-title': 'Sync package',
      'sync-description':
        'An explicit mutation API that retains offline changes in an outbox until confirmation.',
      'sync-offline-note':
        'This demo writes to local IndexedDB; transport is deliberately not started.',
      'sync-queue-mutation': 'Queue offline change',
      'sync-pending': 'Pending changes',

      'state-demo-title': 'Reactive state',
      'utils-demo-title': 'Async helper',

      counter: 'Counter',
      increment: 'Increment',
      decrement: 'Decrement',
      reset: 'Reset',

      'format-demo': 'Formatted date',
      'async-demo': 'Relative time',

      'run-action': 'Run action',
      running: 'Running...',
      'async-idle': 'No async work has run yet.',

      'timestamps-title': 'Timestamps helper',
      createdAt: 'Created at',
      updatedAt: 'Updated at',

      'locale-cookie-title': 'Locale cookie',
      writeCookie: 'Write cookie',
      readCookie: 'Read cookie',
      cookieValue: 'Cookie value',

      'just-now': 'Just now',
      'minutes-ago': '{minutes, plural, =1 {one minute} other {# minutes}} ago',
      'hours-ago': '{hours, plural, =1 {one hour} other {# hours}} ago',
      'days-ago': '{days, plural, =1 {one day} other {# days}} ago',
      'weeks-ago': '{weeks, plural, =1 {one week} other {# weeks}} ago',
      'months-ago': '{months, plural, =1 {one month} other {# months}} ago',
      'years-ago': '{years, plural, =1 {one year} other {# years}} ago',
      'in-minutes': 'in {minutes, plural, =1 {one minute} other {# minutes}}',
      'in-hours': 'in {hours, plural, =1 {one hour} other {# hours}}',
      'in-days': 'in {days, plural, =1 {one day} other {# days}}',
      'in-weeks': 'in {weeks, plural, =1 {one week} other {# weeks}}',
      'in-months': 'in {months, plural, =1 {one month} other {# months}}',
      'in-years': 'in {years, plural, =1 {one year} other {# years}}',
      'today-at': 'Today at {time}',
      'yesterday-at': 'Yesterday at {time}',
    },
    label: 'English',
  },
] as const;
