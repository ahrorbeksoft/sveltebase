export interface CookieOptions {
    expires?: number;
    path?: string;
    domain?: string;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    partitioned?: boolean;
}
export declare const Cookies: {
    set(name: string, value: string, options?: CookieOptions): void;
    get(name: string): string | null;
    remove(name: string, options?: Pick<CookieOptions, "path" | "domain">): void;
};
export declare function timestamps<T extends boolean>(updateOnly: T): T extends true ? {
    updatedAt: number;
} : {
    createdAt: number;
    updatedAt: number;
};
import type { TryCatchReturn } from "./async.svelte.js";
export type { TryCatchReturn } from "./async.svelte.js";
export declare function tryCatch(task: () => Promise<TryCatchReturn> | TryCatchReturn): Promise<void>;
export declare const wait: (ms: number) => Promise<unknown>;
export { createAsync } from "./async.svelte.js";
//# sourceMappingURL=index.d.ts.map