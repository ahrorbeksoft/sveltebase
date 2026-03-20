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
export type TryCatchReturn = {
    success: string;
    error?: never;
} | {
    error: string;
    success?: never;
} | null | void;
export declare function tryCatch(task: () => Promise<TryCatchReturn> | TryCatchReturn): Promise<void>;
export declare const wait: (ms: number) => Promise<unknown>;
export declare function createAsync<T extends (...args: any[]) => Promise<TryCatchReturn> | Promise<void>>(asyncFn: T): {
    isLoading(key?: string): boolean;
    readonly error: Error | null;
    run: (...args: Parameters<T>) => Promise<TryCatchReturn>;
    runWithKey: (key: string, ...args: Parameters<T>) => Promise<TryCatchReturn>;
};
//# sourceMappingURL=index.d.ts.map