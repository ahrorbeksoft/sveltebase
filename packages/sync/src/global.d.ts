namespace App {
  interface Platform {
    env: {
      SYNC_ENGINE: any;
      [key: string]: any;
    };
    context: any;
    caches: any;
  }
}

interface Env {
  SYNC_ENGINE: any;
  [key: string]: any;
}

declare module "$app/environment" {
  export const dev: boolean;
  export const browser: boolean;
  export const building: boolean;
}

declare module "$app/server" {
  export function getRequestEvent(): any;
}
