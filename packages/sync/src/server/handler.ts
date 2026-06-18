export async function publishEvent(
  channel: string,
  action: "create" | "update" | "delete",
  key: string | undefined,
  data: any,
) {
  const envId = "$app/environment";
  let isDev = false;
  try {
    const env = await import(/* @vite-ignore */ envId);
    isDev = env.dev;
  } catch {}

  if (isDev) {
    const { broadcastExternalChange } = await import("./dev-engine.js");
    await broadcastExternalChange(channel, action, key, data);
    return;
  }

  try {
    const serverId = "$app/server";
    const { getRequestEvent } = await import(/* @vite-ignore */ serverId);
    const { platform } = getRequestEvent();
    const namespace = platform?.env.SYNC_ENGINE;
    if (!namespace) return;

    const id = namespace.idFromName("global");
    const stub = namespace.get(id);
    await stub.fetch("https://realtime.internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, action, key, data }),
    });
  } catch (err) {
    console.error("Failed to publish sync event to Durable Object:", err);
  }
}

export async function handleUpgrade(
  request: Request,
  platform: App.Platform | undefined,
): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const namespace = (platform as any)?.env?.SYNC_ENGINE;
  if (!namespace) {
    return new Response("SyncEngine binding is not available", { status: 500 });
  }

  try {
    const id = namespace.idFromName("global");
    const stub = namespace.get(id);
    return await stub.fetch(
      new Request("https://realtime.internal/websocket", request),
    );
  } catch (err: any) {
    return new Response(err.message || "SyncEngine binding is not available", {
      status: 503,
    });
  }
}
