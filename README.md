# baidupan-mcp-worker

A small Cloudflare Worker reverse proxy for Baidu Netdisk's official MCP SSE service.

The Worker keeps the Baidu `access_token` on the server side, rewrites the upstream SSE callback endpoint so MCP clients can communicate through the proxy, and blocks destructive deletion calls before they reach Baidu.

## Why this exists

Baidu's official MCP SSE endpoint expects an `access_token` on the initial SSE connection. Putting that token directly into an MCP client configuration is inconvenient and can expose credentials to clients or logs.

This Worker provides a narrow proxy layer:

```text
MCP client
    |
    v
Cloudflare Access
    |
    v
baidupan-mcp-worker
    |
    +-- inject BAIDU_ACCESS_TOKEN on GET /sse
    +-- rewrite upstream endpoint events
    +-- block file_del locally
    |
    v
Baidu Netdisk official MCP service
```

## Security model

- The Baidu `access_token` is stored only as the Cloudflare Worker secret `BAIDU_ACCESS_TOKEN`.
- Client authentication is expected to be enforced by **Cloudflare Access** in front of the Worker.
- The Worker does not require a second application-level API key.
- Cloudflare Access credentials, cookies, and client authorization headers are not forwarded to Baidu.
- The destructive tool `file_del` is rejected locally before the request reaches the upstream MCP service.
- The proxy validates the upstream origin before forwarding MCP message requests.

This repository contains no real access token. Do not add credentials to `wrangler.jsonc`, source files, `.dev.vars`, or `.env` files.

## Supported behavior

The Worker allows the upstream Baidu MCP toolset except for deletion. Depending on the current official Baidu MCP service, this can include:

- file and directory listing;
- metadata queries;
- image/document/video listing;
- keyword or semantic search;
- creating directories;
- copying, moving, and renaming files;
- URL/text upload tools;
- share-link creation;
- user information and storage quota queries.

### Intentionally blocked

- `file_del` — deleting files or directories.

The tool can still appear in upstream MCP tool discovery, but calls are rejected by this Worker.

## Endpoints

- `GET /health` — service status
- `GET /sse` — proxied MCP SSE endpoint
- `POST /message` — proxied MCP message endpoint

Protect the externally reachable Worker or custom domain with Cloudflare Access.

## Setup

Install dependencies:

```bash
npm install
```

Store the Baidu token as a Worker secret:

```bash
npx wrangler secret put BAIDU_ACCESS_TOKEN
```

Deploy:

```bash
npm run deploy
```

A typical MCP endpoint is:

```text
https://<your-access-protected-host>/sse
```

## Cloudflare Access

The Worker itself does not implement a second login system. Configure Cloudflare Access at the edge so unauthorized clients cannot reach `/sse` or `/message`.

For a personal deployment, protecting the whole Worker hostname is the simplest model. If you expose `/health` publicly, make that an explicit Access-policy decision rather than relying on obscurity.

## Privacy and logging

The proxy should never log or return the value of `BAIDU_ACCESS_TOKEN`. Error logging is intentionally limited to status and non-secret diagnostic metadata rather than upstream response bodies.

When enabling Cloudflare observability, remember that request metadata may still contain file names, paths, or other user-generated information depending on your own logging configuration.

## Development

```bash
npm run dev
```

The repository ignores local secret/config files and Wrangler state. Keep production credentials in Cloudflare Secrets.

## Scope

This project is a compatibility/security proxy, not an independent Baidu Netdisk implementation. Availability and tool behavior depend on Baidu's official MCP service and may change upstream.

## License

MIT
