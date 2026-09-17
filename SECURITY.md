# LocalMCP Relay security notes

This repository exposes a high-impact remote-control surface: possession of a valid MCP URL can allow the caller to invoke every LocalMCP tool enabled by the local configuration, including shell/process tools.

## 1. Protect device registration

Self-hosted Workers can require a registration secret without changing the MCP URL format used by ChatGPT.

Generate a 256-bit secret and its SHA-256 hash locally:

```powershell
node -e "const c=require('crypto');const s=c.randomBytes(32).toString('hex');console.log('REGISTRATION_SECRET='+s);console.log('REGISTRATION_TOKEN_HASH='+c.createHash('sha256').update(s).digest('hex'))"
```

Store only the hash in Cloudflare:

```powershell
npx wrangler secret put REGISTRATION_TOKEN_HASH --config wrangler.jsonc
```

When a fresh LocalMCP device must register, provide the raw secret only to that local process:

```powershell
$env:LOCALMCP_WORKER_URL='https://YOUR-WORKER.workers.dev'
$env:LOCALMCP_REGISTRATION_TOKEN='YOUR-RAW-REGISTRATION-SECRET'
localmcp
Remove-Item Env:\LOCALMCP_REGISTRATION_TOKEN
```

Existing devices with a valid `~/.localmcp/worker.json` do not call `/register` when they reconnect, so enabling the Worker secret does not invalidate their current agent token.

If `REGISTRATION_TOKEN_HASH` is not configured, `/register` remains backward-compatible and open. For a private self-hosted relay, configure the secret.

## 2. Rotate a leaked MCP URL

The hardened Worker adds:

```text
POST /rotate/<deviceId>
Authorization: Bearer <current-mcp-token>
```

A successful rotation updates only the stored MCP-token hash. The agent token and current agent WebSocket are left unchanged. The old `/mcp/<deviceId>/<token>` URL becomes invalid immediately.

After deploying the hardened Worker, from a checkout of this repository run:

```powershell
npm run worker:rotate
```

The helper reads `~/.localmcp/worker.json`, authenticates with the current MCP token, atomically writes the new token back to `worker.json`, and prints the new MCP URL.

Then restart the local agent so `localmcp status` and `connection.json` use the new URL:

```powershell
localmcp stop
localmcp
```

Finally replace the old MCP URL in ChatGPT with the newly printed URL. Do not paste the new URL into GitHub issues, chat screenshots, logs, README files, or source control.

If the current MCP token may already be fully compromised, rotate promptly. Whoever successfully uses the current token first can call the rotation endpoint, so token rotation is not a substitute for keeping the current token secret.

## 3. Local privilege boundary

File tools are workspace-confined and reject path traversal and symbolic links. Shell/process tools are intentionally more powerful: a shell launched with the workspace as its working directory can still access other locations permitted to the Windows/Linux user account.

For lower risk:

- disable `features.shell` and `features.processes` when they are not needed;
- run LocalMCP as a dedicated non-administrator OS account when practical;
- grant that account only the repositories, tools, and SSH keys needed for the intended workflow;
- treat the complete MCP URL like an SSH private key or API secret.

## 4. What does not change

This hardening does **not** change the ChatGPT MCP transport shape. ChatGPT still connects to:

```text
https://YOUR-WORKER.workers.dev/mcp/<deviceId>/<mcpToken>
```

Only registration protection and explicit MCP-token rotation are added.
