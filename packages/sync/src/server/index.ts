import type { ZodSchema } from "zod";

export type SyncConnectionAuth<TUser = unknown> = {
  user: TUser;
};

export type SyncPlatform<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
> = {
  env: TEnv;
  ctx?: ExecutionContext;
  context?: ExecutionContext;
  caches?: CacheStorage;
  cf?: IncomingRequestCfProperties;
};

export type SyncContext<
  TAuth = any,
  TEnv extends Record<string, unknown> = Record<string, unknown>,
> = {
  platform: SyncPlatform<TEnv>;
  request: Request;
  auth: TAuth | null;
  identity: string | null;
};

export type SyncHandlerConfig<TRow = any, TAuth = any> = {
  channel: string | ((ctx: SyncContext<TAuth>) => string);
  fetch: (ctx: SyncContext<TAuth>, since?: string) => Promise<TRow[]>;
  create?: (ctx: SyncContext<TAuth>, data: TRow) => Promise<TRow>;
  update?: (
    ctx: SyncContext<TAuth>,
    key: string,
    changes: Partial<TRow>,
  ) => Promise<TRow>;
  delete?: (ctx: SyncContext<TAuth>, key: string) => Promise<void>;
  authorize?: (ctx: SyncContext<TAuth>) => Promise<void>;
  validate?: {
    create?: ZodSchema<any>;
    update?: ZodSchema<any>;
  };
  scope?: (
    ctx: SyncContext<TAuth>,
    action: "create" | "update" | "delete",
    data: TRow,
  ) => Promise<string[] | "all"> | string[] | "all";
};

export interface SyncHandler<TRow = any, TAuth = any> {
  config: SyncHandlerConfig<TRow, TAuth>;
  resolveChannel(ctx: SyncContext<TAuth>): string;
}

export function defineSync<TRow = any, TAuth = any>(
  config: SyncHandlerConfig<TRow, TAuth>,
): SyncHandler<TRow, TAuth> {
  return {
    config,
    resolveChannel(ctx: SyncContext<TAuth>): string {
      return typeof config.channel === "function"
        ? config.channel(ctx)
        : config.channel;
    },
  };
}

export {
  createBulkPublisher,
  createPublishChangeEvent,
  createPublisher,
  INTERNAL_AUTH_HEADER,
  publishBulkEvent,
  publishChangeEvent,
  publishEvent,
} from "./handler.js";
export type {
  BulkPublishFn,
  PublishChangeEventFn,
  PublishBulkEventFn,
  PublishEventData,
  PublishEventFn,
  PublishFn,
  SyncAuthResult,
} from "./handler.js";
