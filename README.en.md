# nmail-mcp

[![CI](https://github.com/yakisoba0728/nmail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yakisoba0728/nmail-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yakisoba0728/nmail-mcp)](https://github.com/yakisoba0728/nmail-mcp/releases)
[![License](https://img.shields.io/github/license/yakisoba0728/nmail-mcp)](LICENSE)

[한국어](README.md) | English

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for Naver Mail (네이버 메일). It lets LLM clients search, read, send, and organize Naver Mail over IMAP/SMTP.

It runs on Cloudflare Workers, Node.js, or Docker, and supports both remote (HTTP + OAuth) and local (stdio) connections. It works with ChatGPT, Claude, Claude Code, Codex, Cursor, VS Code, and any other MCP client.

> This is not an official Naver project.

## Features

- **Search**: Gmail search syntax, all-folder search, body keyword search
- **Read**: body, attachments, links, SPF/DKIM/DMARC results, calendar invitations (.ics), raw source and full headers
- **Threads**: received and sent mail joined into one conversation, oldest first
- **Send**: new mail, reply, forward, drafts, calendar invitation replies, unsubscribe
- **Organize**: move, read/starred flags, delete, folder management, bulk actions on search results
- **Automation**: scheduled send, filing rules for new mail, vacation responder
- **Korean mail**: EUC-KR/cp949 bodies, RFC 2047/2231 Korean file names, Korean folder names

## Requirements

- A Naver account
  1. Naver ID → Security settings → enable **2-step verification**
  2. 2-step verification → Manage → create an **application password**
  3. Naver Mail → Settings → POP3/IMAP → enable **IMAP/SMTP**
- One runtime: a Cloudflare account, Node.js 22.13 or later, or Docker
- An MCP client

## Deployment options

| Option | Transport | Auth | Automation (scheduled send, rules, vacation) | Use when |
|---|---|---|---|---|
| [Cloudflare Workers](#cloudflare-workers) | HTTP | OAuth | Cron Triggers | Remote access without a server |
| [Docker](#docker) | HTTP or stdio | OAuth (HTTP) | Built-in timer | VPS, NAS, home server, Fly.io, Railway, Render |
| [Node.js](#nodejs) | HTTP or stdio | OAuth (HTTP) | Built-in timer | Running it directly |
| [Local (stdio)](#local-stdio) | stdio | None (local process) | Only while the client runs | A single desktop client |

HTTP works with every client that supports remote MCP servers. With stdio, the client starts the server process itself.

## Installation

### Cloudflare Workers

```bash
git clone https://github.com/yakisoba0728/nmail-mcp
cd nmail-mcp
npm install
npx wrangler login

npx wrangler secret put NAVER_ID
npx wrangler secret put NAVER_APP_PASSWORD

npm run deploy
```

The MCP endpoint is `https://nmail-mcp.<subdomain>.workers.dev/mcp`. The KV namespace and Cron Triggers are created on the first deploy.

- If your Cloudflare login has several accounts, set `CLOUDFLARE_ACCOUNT_ID` in `.env`.
- Where KV auto-provisioning is unavailable, create a namespace with `npx wrangler kv namespace create OAUTH_KV` and add its id to `kv_namespaces` in `wrangler.jsonc`.
- See [Resource usage](#resource-usage-cloudflare-workers) for per-request CPU time.

### Docker

Image: `ghcr.io/yakisoba0728/nmail-mcp` (linux/amd64, linux/arm64)

```bash
docker run -d --name nmail-mcp \
  -e NAVER_ID=myid \
  -e NAVER_APP_PASSWORD=xxxxxxxxxxxx \
  -e PUBLIC_URL=https://mail.example.com \
  -e TRUST_PROXY=1 \
  -p 127.0.0.1:8787:8787 \
  -v nmail-data:/data \
  ghcr.io/yakisoba0728/nmail-mcp:latest
```

With docker compose:

```bash
cp .env.docker.example .env.docker   # fill in the values
docker compose up -d
```

State (OAuth tokens, scheduled mail, rules) is kept in a SQLite file under `/data`. To reach it from outside, see [Exposing over HTTPS](#exposing-over-https).

### Node.js

Download the single-file build from the latest release. No dependencies are needed.

```bash
curl -LO https://github.com/yakisoba0728/nmail-mcp/releases/latest/download/nmail-mcp.mjs
NAVER_ID=myid NAVER_APP_PASSWORD=xxxxxxxxxxxx node nmail-mcp.mjs serve
```

To build from source:

```bash
npm ci
npm run build
node --env-file=.env.local dist/nmail-mcp.mjs serve
```

<details>
<summary>systemd unit</summary>

```ini
# /etc/systemd/system/nmail-mcp.service
[Unit]
Description=nmail-mcp
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/nmail-mcp/nmail-mcp.mjs serve
EnvironmentFile=/etc/nmail-mcp.env
Environment=DATA_DIR=/var/lib/nmail-mcp
StateDirectory=nmail-mcp
DynamicUser=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
</details>

### Exposing over HTTPS

The `serve` mode of Docker and Node.js answers plain HTTP. For remote clients, put it behind an HTTPS reverse proxy or tunnel and set `PUBLIC_URL` to the external address. OAuth tokens are bound to that address.

<details>
<summary>Caddy</summary>

```caddyfile
mail.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

`PUBLIC_URL=https://mail.example.com`, `TRUST_PROXY=1`
</details>

<details>
<summary>Cloudflare Tunnel</summary>

```bash
cloudflared tunnel create nmail
cloudflared tunnel route dns nmail mail.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 nmail
```

`PUBLIC_URL=https://mail.example.com`, `TRUST_PROXY=1`
</details>

<details>
<summary>Tailscale Funnel</summary>

```bash
tailscale funnel 8787
```

`PUBLIC_URL=https://<machine>.<tailnet>.ts.net`, `TRUST_PROXY=1`
</details>

### Local (stdio)

The client starts the server. There is no OAuth sign-in; credentials are passed as environment variables in the client configuration.

Standard configuration:

```json
{
  "mcpServers": {
    "nmail": {
      "command": "node",
      "args": ["/path/to/nmail-mcp.mjs", "stdio"],
      "env": {
        "NAVER_ID": "myid",
        "NAVER_APP_PASSWORD": "xxxxxxxxxxxx"
      }
    }
  }
}
```

With Docker:

```json
{
  "mcpServers": {
    "nmail": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "NAVER_ID", "-e", "NAVER_APP_PASSWORD", "-v", "nmail-data:/data", "ghcr.io/yakisoba0728/nmail-mcp", "stdio"],
      "env": {
        "NAVER_ID": "myid",
        "NAVER_APP_PASSWORD": "xxxxxxxxxxxx"
      }
    }
  }
}
```

Scheduled send, rules, and the vacation responder run only while the server process is running. Use an HTTP deployment if they must always run.

## Connecting a client

### Remote (HTTP)

The endpoint is `https://<host>/mcp`. It uses Streamable HTTP and OAuth 2.1 (dynamic client registration, PKCE), so no client ID or API key is required. Connecting opens a sign-in page; enter the Naver application password to finish.

<details>
<summary>ChatGPT</summary>

Enable developer mode in settings, add a custom connector, and enter the URL with OAuth authentication.
</details>

<details>
<summary>Claude (web and desktop)</summary>

Settings → Connectors → Add custom connector, then enter the URL.
</details>

<details>
<summary>Claude Code</summary>

```bash
claude mcp add --transport http nmail https://<host>/mcp
```

Then sign in from `/mcp`.
</details>

<details>
<summary>Codex</summary>

```bash
codex mcp add nmail --url https://<host>/mcp
codex mcp login nmail
```
</details>

<details>
<summary>Cursor</summary>

`~/.cursor/mcp.json`:

```json
{ "mcpServers": { "nmail": { "url": "https://<host>/mcp" } } }
```
</details>

<details>
<summary>VS Code</summary>

`.vscode/mcp.json`:

```json
{ "servers": { "nmail": { "type": "http", "url": "https://<host>/mcp" } } }
```
</details>

### Local (stdio)

<details>
<summary>Claude Desktop</summary>

Add the [standard configuration](#local-stdio) to `claude_desktop_config.json`.
</details>

<details>
<summary>Claude Code</summary>

```bash
claude mcp add nmail -e NAVER_ID=myid -e NAVER_APP_PASSWORD=xxxxxxxxxxxx -- node /path/to/nmail-mcp.mjs stdio
```
</details>

<details>
<summary>Codex</summary>

`~/.codex/config.toml`:

```toml
[mcp_servers.nmail]
command = "node"
args = ["/path/to/nmail-mcp.mjs", "stdio"]
env = { NAVER_ID = "myid", NAVER_APP_PASSWORD = "xxxxxxxxxxxx" }
```
</details>

<details>
<summary>Cursor</summary>

Add the [standard configuration](#local-stdio) to `~/.cursor/mcp.json`.
</details>

<details>
<summary>VS Code</summary>

`.vscode/mcp.json`:

```json
{
  "servers": {
    "nmail": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/nmail-mcp.mjs", "stdio"],
      "env": { "NAVER_ID": "myid", "NAVER_APP_PASSWORD": "xxxxxxxxxxxx" }
    }
  }
}
```
</details>

Configuration file locations and menu names vary between client versions; check each client's documentation as well.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `NAVER_ID` | yes | | Naver ID (without `@naver.com`) |
| `NAVER_APP_PASSWORD` | yes | | Naver application password; over HTTP it is also the OAuth sign-in password |
| `NAVER_NAME` | | | Sender display name |
| `NAVER_SIGNATURE` | | | Signature (`\n` for line breaks) |
| `PORT` | | `8787` | Node.js/Docker: listen port |
| `HOST` | | `127.0.0.1` (Docker: `0.0.0.0`) | Node.js/Docker: listen address |
| `DATA_DIR` | | `./data` (Docker: `/data`) | Node.js/Docker: state directory |
| `PUBLIC_URL` | | request URL | Node.js/Docker: external address; required behind a proxy or tunnel |
| `TRUST_PROXY` | | | Node.js/Docker: `1` trusts `X-Forwarded-*` headers |

On Cloudflare Workers, set the first four with `wrangler secret put`.

## Tools

Messages are addressed as `{folder, uid}`. Folder aliases `inbox`, `sent`, `drafts`, `trash`, and `spam` (and the Korean names such as `받은메일함`) are accepted anywhere a folder is.

<details>
<summary><b>Search and read</b></summary>

| Tool | Description |
|---|---|
| `search_emails` | Search with Gmail syntax, folder selection, body keywords (`maxScan`, `resume`), previews (`snippets`) |
| `read_email` | Read a message. `format`: `text`, `html`, `raw`, `headers` |
| `get_thread` | A whole conversation, oldest first |
| `get_attachment` | An attachment (images are returned as image content) |
| `find_contacts` | Contacts from sent and received mail |
| `sender_stats` | Message counts by sender |
</details>

<details>
<summary><b>Send</b></summary>

| Tool | Description |
|---|---|
| `send_email` | Send a new message: Cc, Bcc, HTML, attachments, inline images, Reply-To, priority, read receipt, signature |
| `reply_email` | Reply or reply all; `asDraft` saves instead of sending |
| `forward_email` | Forward with the original attachments; `asDraft` saves instead of sending |
| `respond_to_invite` | Accept, decline, or tentatively accept a calendar invitation (iCalendar REPLY) |
| `unsubscribe` | One-click unsubscribe (RFC 8058) or a mailto request |
</details>

<details>
<summary><b>Drafts</b></summary>

| Tool | Description |
|---|---|
| `save_draft` | Save a draft |
| `list_drafts` | List drafts |
| `update_draft` | Change some fields (attachments and threading headers are kept) |
| `send_draft` | Send and remove from Drafts |
</details>

<details>
<summary><b>Organize</b></summary>

| Tool | Description |
|---|---|
| `move_emails` | Move to a folder (`spam` reports spam, `inbox` restores) |
| `set_flags` | Read, starred, answered flags |
| `delete_emails` | Move to Trash or delete permanently |
| `bulk_action` | Apply an action to search results; requires a dry run (`dryRun`) and the count (`expectedCount`), no permanent delete |
| `manage_folder` | Create, rename, delete folders |
| `list_folders` | Folders with message counts |
| `get_profile` | Account information and storage usage |
</details>

<details>
<summary><b>Automation</b></summary>

| Tool | Description |
|---|---|
| `schedule_email` | Scheduled send (times without an offset are Korea time) |
| `cancel_scheduled` | Cancel a scheduled message |
| `create_rule` | Filing rule for new mail: mark read, star, move, trash |
| `delete_rule` | Delete a rule |
| `set_vacation` | Vacation auto-reply (end date required) |
| `list_automations` | Scheduled mail, rules, and vacation responder status |
</details>

### Search syntax

`query` in `search_emails` follows Gmail search syntax; all terms are ANDed.

| Example | Meaning |
|---|---|
| `invoice "card approved" -ad` | Words, phrases, exclusion |
| `from:shop@example.com`, `-from:spam` | Sender |
| `to:` `cc:` `bcc:` `subject:` | Recipients, subject |
| `after:2026/11/01`, `before:2026/12/01` | Dates (Korea time) |
| `newer_than:7d`, `older_than:1y` | Relative dates (`d`, `w`, `m`, `y`) |
| `is:unread`, `is:starred`, `is:answered` | State |
| `has:attachment`, `filename:pdf` | Attachments |
| `larger:5M`, `smaller:100K` | Size |
| `in:sent`, `in:anywhere` | Folder |

Unsupported operators (`OR`, `category:`, and others) are reported in the result's `warnings`.

## Naver IMAP compatibility

The implementation accounts for the following behavior of Naver's IMAP server.

| Server behavior | Handling |
|---|---|
| BODY/TEXT search always returns nothing | Subject and sender are searched on the server; bodies are fetched (first part only) and matched locally |
| HEADER search works only for Message-ID | Threads are built from Message-ID lookups and subject search |
| OR combined with HEADER returns nothing | Header searches are sent separately |
| UIDs are account-wide and UIDNEXT is lower than the actual maximum | New-mail detection uses the actual highest UID |
| Mail sent over SMTP is not saved to Sent | A copy is appended to Sent after sending |
| No SORT or THREAD extension | Sorting and threading are done by the server |

## Resource usage (Cloudflare Workers)

Per-request CPU time measured with `wrangler tail` on a Cloudflare deployment (November 2026).

| Request | CPU (ms) |
|---|---:|
| OAuth registration, authorization, token | 3–6 |
| `tools/list` | 11–36 |
| `read_email` | 23–31 |
| `list_folders`, `get_profile` | 44–46 |
| `search_emails` | 41–59 |
| `get_thread` | 40 |
| `sender_stats`, `find_contacts` | 74–111 |

Most requests exceed the Workers Free per-request CPU limit (10 ms); the Workers Paid plan is recommended. Node.js and Docker have no such limit.

## Security

- Naver credentials are passed only as secrets (Workers) or environment variables (Node.js, Docker) and are never written to storage (KV, SQLite). Storage holds OAuth tokens and automation state only.
- The OAuth sign-in page shows where access will be granted and warns about unknown web origins. Sign-in attempts are limited to 5 per minute per IP.
- Treat message content as untrusted input. Tool descriptions require user confirmation before sending or deleting, but the server does not enforce it; enable your client's tool approval prompts.
- Auto-forwarding rules are not supported.
- `bulk_action` cannot delete permanently and refuses to run if the count differs from its dry run.
- The vacation responder follows RFC 3834 and does not reply to mailing lists, automated mail, or your own address.
- On Node.js there is no guard against requests to private addresses, so URL-based OAuth client IDs (CIMD) are disabled there; dynamic client registration is used instead.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # NAVER_ID, NAVER_APP_PASSWORD
```

| Command | Description |
|---|---|
| `npm run dev` | Local Workers server (`http://localhost:8787/mcp`) |
| `npm run build` | Node.js bundle (`dist/nmail-mcp.mjs`) |
| `npm start` | Run the Node.js server |
| `npm test` | Unit tests |
| `npm run typecheck` | Type check |
| `npm run e2e` | Integration test against a real account; needs a running server (`BASE` sets its URL), mails only your own address, and deletes its test mail at the end |
| `node test/stdio.mjs` | stdio mode check |
| `npm run bench` | Per-tool CPU measurement (Node.js) |

| Path | Contents |
|---|---|
| `src/index.ts` | Workers entry point, OAuth, cron |
| `src/node/` | Node.js entry point (`serve`, `stdio`), SQLite KV |
| `src/auth.ts` | OAuth sign-in page |
| `src/tools.ts` | MCP tool definitions |
| `src/imap.ts`, `src/smtp.ts` | IMAP and SMTP clients |
| `src/mime.ts` | Charsets, encodings, HTML to text, attachments, iCalendar |
| `src/mail.ts`, `src/read.ts`, `src/send.ts`, `src/organize.ts` | Folders, reading, sending, organizing |
| `src/search.ts` | Search, threads, statistics |
| `src/automation.ts` | Scheduled send, rules, vacation responder |

## Limitations

- A thread looked up from the original message may miss replies whose subject was changed. Looking it up from the reply includes the original.
- Body keyword search checks only the beginning of each message (6 KB of text, 18 KB of HTML).
- On Cloudflare Workers, overlapping cron runs can send a scheduled message twice.
- While a filing rule or the vacation responder is active, the server signs in to IMAP every 5 minutes.

## License

[Apache License 2.0](LICENSE)
