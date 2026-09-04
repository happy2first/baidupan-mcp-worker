export interface Env {
  BAIDU_ACCESS_TOKEN: string;
}

const UPSTREAM_ORIGIN = "https://mcp-pan.baidu.com";
const BLOCKED_TOOL = "file_del";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Baidu's official SSE URL carries access_token only on the initial GET /sse.
function upstreamSseUrl(token: string): URL {
  const u = new URL("/sse", UPSTREAM_ORIGIN);
  u.searchParams.set("access_token", token);
  return u;
}

// The POST endpoint is supplied by Baidu in the SSE "endpoint" event.
// Official MCP SSE clients POST to that endpoint directly and do not append
// the access_token again.
function upstreamMessageUrl(pathOrUrl: string): URL {
  const u = new URL(pathOrUrl, UPSTREAM_ORIGIN);
  if (u.origin !== UPSTREAM_ORIGIN) throw new Error("Invalid upstream origin");
  u.searchParams.delete("access_token");
  return u;
}

function safeEndpoint(raw: string): string {
  const u = new URL(raw, UPSTREAM_ORIGIN);
  if (u.origin !== UPSTREAM_ORIGIN) throw new Error("Invalid endpoint origin");
  u.searchParams.delete("access_token");
  return u.pathname + (u.search ? u.search : "");
}

function proxyEndpoint(req: Request, upstreamEndpoint: string): string {
  const incoming = new URL(req.url);
  const out = new URL("/message", incoming.origin);
  out.searchParams.set("upstream", upstreamEndpoint);
  return out.toString();
}

function transformSse(req: Request, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let currentEvent = "";

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (let line of lines) {
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        if (currentEvent === "endpoint" && line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          try {
            line = `data: ${proxyEndpoint(req, safeEndpoint(raw))}`;
          } catch {
            line = "data: /invalid-endpoint";
          }
        }
        controller.enqueue(encoder.encode(line + "\n"));
        if (line === "") currentEvent = "";
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(buffer));
    },
  }));
}

async function handleSse(req: Request, env: Env): Promise<Response> {
  const upstream = upstreamSseUrl(env.BAIDU_ACCESS_TOKEN);
  const r = await fetch(upstream, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "user-agent": "baidupan-mcp-worker/1.2",
    },
  });

  console.log(JSON.stringify({
    kind: "baidu_sse",
    status: r.status,
    hasSetCookie: r.headers.has("set-cookie"),
  }));

  if (!r.ok || !r.body) {
    const text = await r.text();
    console.error(JSON.stringify({
      kind: "baidu_sse_error",
      status: r.status,
      contentType: r.headers.get("content-type"),
    }));
    return new Response(text, { status: r.status });
  }

  const headers = new Headers(r.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.delete("content-length");
  return new Response(transformSse(req, r.body), { status: r.status, headers });
}

async function handleMessage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("upstream");
  if (!path) return json({ error: "missing upstream" }, 400);

  const raw = await req.text();
  try {
    const msg = JSON.parse(raw);
    if (msg?.method === "tools/call" && msg?.params?.name === BLOCKED_TOOL) {
      return json({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: {
          code: -32001,
          message: "Baidu Netdisk delete operation is disabled by proxy policy",
        },
      });
    }
  } catch {
    // Let upstream validate non-JSON payloads.
  }

  const upstream = upstreamMessageUrl(path);

  // Never forward Cloudflare Access credentials, cookies, or other client
  // authentication material to Baidu.
  const headers = new Headers();
  headers.set("content-type", req.headers.get("content-type") || "application/json");
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  headers.set("user-agent", "baidupan-mcp-worker/1.2");

  const r = await fetch(upstream, { method: "POST", headers, body: raw });

  if (!r.ok) {
    console.error(JSON.stringify({
      kind: "baidu_message_error",
      status: r.status,
      upstreamPath: upstream.pathname,
      hasSessionId: upstream.searchParams.has("sessionId") || upstream.searchParams.has("session_id"),
      contentType: r.headers.get("content-type"),
    }));
  }

  const outHeaders = new Headers(r.headers);
  outHeaders.delete("content-length");
  return new Response(r.body, { status: r.status, headers: outHeaders });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "baidupan-mcp-worker",
        version: "1.2",
        auth: "Cloudflare Access (configured at the edge)",
        policy: "all upstream MCP tools allowed except file_del",
        upstream: UPSTREAM_ORIGIN,
      });
    }

    if (!env.BAIDU_ACCESS_TOKEN) {
      return json({ error: "BAIDU_ACCESS_TOKEN is not configured" }, 503);
    }

    if (url.pathname === "/sse" && req.method === "GET") return handleSse(req, env);
    if (url.pathname === "/message" && req.method === "POST") return handleMessage(req);

    return json({ error: "Not found" }, 404);
  },
};
