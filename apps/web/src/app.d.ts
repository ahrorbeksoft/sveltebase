/// <reference types="@sveltejs/kit" />

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	interface ImportMetaEnv {
		readonly PUBLIC_INSTANT_APP_ID: string;
		readonly PRIVATE_INSTANT_ADMIN_TOKEN: string;
	}

	interface ImportMeta {
		readonly env: ImportMetaEnv;
	}
}

export {};
