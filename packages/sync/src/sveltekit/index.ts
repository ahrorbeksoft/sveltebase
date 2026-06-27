import type { RequestHandler } from "@sveltejs/kit";

export type SyncProxyOptions = {
  binding?: string;
  fallbackUrl?: string;
};

function buildFallbackRequest(request: Request, fallbackUrl: string) {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(fallbackUrl);
  targetUrl.search = sourceUrl.search;

  return new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
  });
}

export function syncProxy(options?: SyncProxyOptions): {
  GET: RequestHandler;
  POST: RequestHandler;
} {
  const bindingName = options?.binding ?? "SYNC_WORKER";

  const handler: RequestHandler = async (event) => {
    const platform = event.platform as
      | { env?: Record<string, unknown> }
      | undefined;
    const serviceBinding = platform?.env?.[bindingName] as
      | Fetcher
      | undefined;

    if (serviceBinding?.fetch) {
      return serviceBinding.fetch(event.request);
    }

    if (options?.fallbackUrl) {
      return fetch(buildFallbackRequest(event.request, options.fallbackUrl));
    }

    return new Response(
      `Missing sync Worker binding ${bindingName}. Configure a service binding or pass fallbackUrl to syncProxy().`,
      { status: 500 },
    );
  };

  return {
    GET: handler,
    POST: handler,
  };
}
