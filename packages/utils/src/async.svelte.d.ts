export type TryCatchReturn = {
    success: string;
    error?: never;
} | {
    error: string;
    success?: never;
} | null | void;
export declare function createAsync<T extends (...args: any[]) => Promise<TryCatchReturn> | Promise<void>>(asyncFn: T): {
    /**
     * Check loading state.
     * Pass a key for specific actions, or call without args for global actions.
     */
    isLoading(key?: string): boolean;
    readonly error: Error | null;
    run: (...args: Parameters<T>) => Promise<TryCatchReturn>;
    runWithKey: (key: string, ...args: Parameters<T>) => Promise<TryCatchReturn>;
};
//# sourceMappingURL=async.svelte.d.ts.map