import type { ZodSchema } from "zod";

export type SyncContext = {
  platform: App.Platform | undefined;
  request: Request;
  auth?: any;
};

export type SyncHandlerConfig<TRow = any> = {
  channel: string | ((ctx: SyncContext) => string);
  fetch: (ctx: SyncContext, since?: string) => Promise<TRow[]>;
  create?: (ctx: SyncContext, data: TRow) => Promise<TRow>;
  update?: (
    ctx: SyncContext,
    key: string,
    changes: Partial<TRow>,
  ) => Promise<TRow>;
  delete?: (ctx: SyncContext, key: string) => Promise<void>;
  authorize?: (ctx: SyncContext) => Promise<void>;
  validate?: {
    create?: ZodSchema<any>;
    update?: ZodSchema<any>;
  };
  scope?: (
    ctx: SyncContext,
    action: "create" | "update" | "delete",
    data: TRow,
  ) => Promise<string[] | "all"> | string[] | "all";
};

export interface SyncHandler<TRow = any> {
  config: SyncHandlerConfig<TRow>;
  resolveChannel(ctx: SyncContext): string;
}

export function defineSync<TRow = any>(
  config: SyncHandlerConfig<TRow>,
): SyncHandler<TRow> {
  return {
    config,
    resolveChannel(ctx: SyncContext): string {
      return typeof config.channel === "function"
        ? config.channel(ctx)
        : config.channel;
    },
  };
}
