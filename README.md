# nmail-mcp

[![CI](https://github.com/yakisoba0728/nmail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yakisoba0728/nmail-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yakisoba0728/nmail-mcp)](https://github.com/yakisoba0728/nmail-mcp/releases)
[![License](https://img.shields.io/github/license/yakisoba0728/nmail-mcp)](LICENSE)

한국어 | [English](README.en.md)

네이버 메일용 [MCP(Model Context Protocol)](https://modelcontextprotocol.io) 서버입니다. LLM 클라이언트가 IMAP/SMTP를 통해 네이버 메일을 검색하고, 읽고, 보내고, 정리할 수 있게 합니다.

Cloudflare Workers, Node.js, Docker 어디서나 실행되고, 원격(HTTP + OAuth)과 로컬(stdio) 연결을 모두 지원합니다. ChatGPT, Claude, Claude Code, Codex, Cursor, VS Code 등 MCP를 지원하는 클라이언트에서 사용할 수 있습니다.

> 네이버의 공식 프로젝트가 아닙니다.

## 주요 기능

- **검색**: Gmail 검색어 문법, 전체 메일함 검색, 본문 키워드 검색
- **읽기**: 본문, 첨부, 링크, SPF/DKIM/DMARC 결과, 일정 초대(.ics), 원문과 전체 헤더
- **대화**: 받은 메일과 보낸 메일을 하나의 스레드로 묶어 시간순 정렬
- **보내기**: 새 메일, 답장, 전달, 임시보관함, 일정 초대 회신, 수신거부
- **정리**: 이동, 읽음·별표 표시, 삭제, 메일함 관리, 검색 결과 일괄 처리
- **자동화**: 예약 발송, 새 메일 자동 분류 규칙, 부재중 자동 응답
- **한국어 메일**: EUC-KR·cp949 본문, RFC 2047/2231 한글 파일명, 한글 메일함 이름

## 요구 사항

- 네이버 계정
  1. 네이버 ID → 보안설정 → **2단계 인증** 사용
  2. 2단계 인증 → 관리 → **애플리케이션 비밀번호** 생성
  3. 네이버 메일 → 환경설정 → POP3/IMAP 설정 → **IMAP/SMTP 사용** 선택
- 실행 환경 중 하나: Cloudflare 계정, Node.js 22.13 이상, Docker
- MCP 클라이언트

## 실행 방식

| 방식 | 연결 | 인증 | 자동화(예약 발송·규칙·부재중) | 적합한 경우 |
|---|---|---|---|---|
| [Cloudflare Workers](#cloudflare-workers) | HTTP | OAuth | 크론 트리거 | 서버 없이 원격 접속 |
| [Docker](#docker) | HTTP 또는 stdio | OAuth (HTTP) | 내장 타이머 | VPS, NAS, 홈서버, Fly.io·Railway·Render 등 |
| [Node.js](#nodejs) | HTTP 또는 stdio | OAuth (HTTP) | 내장 타이머 | 직접 실행 |
| [로컬 (stdio)](#로컬-stdio) | stdio | 없음 (로컬 프로세스) | 클라이언트 실행 중에만 | 데스크톱 클라이언트 단독 사용 |

HTTP 방식은 원격 MCP를 지원하는 모든 클라이언트에서 사용할 수 있고, stdio 방식은 클라이언트가 서버 프로세스를 직접 실행합니다.

## 설치

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

배포가 끝나면 `https://nmail-mcp.<하위 도메인>.workers.dev/mcp`가 MCP 엔드포인트가 됩니다. KV 네임스페이스와 크론 트리거는 첫 배포 시 생성됩니다.

- Cloudflare 로그인에 계정이 여러 개 연결되어 있으면 `.env`에 `CLOUDFLARE_ACCOUNT_ID`를 지정합니다.
- KV 자동 생성이 지원되지 않는 환경에서는 `npx wrangler kv namespace create OAUTH_KV`로 생성한 ID를 `wrangler.jsonc`의 `kv_namespaces`에 추가합니다.
- 요청당 CPU 사용량은 [리소스 사용량](#리소스-사용량-cloudflare-workers)을 참고하세요.

### Docker

이미지: `ghcr.io/yakisoba0728/nmail-mcp` (linux/amd64, linux/arm64)

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

docker compose를 사용하는 경우:

```bash
cp .env.docker.example .env.docker   # 값 입력
docker compose up -d
```

상태(OAuth 토큰, 예약 메일, 규칙)는 `/data`의 SQLite 파일에 저장됩니다. 외부에서 접속하려면 [HTTPS로 공개](#https로-공개)를 참고하세요.

### Node.js

릴리스의 단일 파일을 받아 실행합니다. 의존성 설치가 필요 없습니다.

```bash
curl -LO https://github.com/yakisoba0728/nmail-mcp/releases/latest/download/nmail-mcp.mjs
NAVER_ID=myid NAVER_APP_PASSWORD=xxxxxxxxxxxx node nmail-mcp.mjs serve
```

소스에서 빌드하는 경우:

```bash
npm ci
npm run build
node --env-file=.env.local dist/nmail-mcp.mjs serve
```

<details>
<summary>systemd 서비스 예시</summary>

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

### HTTPS로 공개

Docker와 Node.js의 `serve` 모드는 HTTP로만 응답합니다. 원격 클라이언트에서 사용하려면 HTTPS 리버스 프록시나 터널 뒤에 두고, 외부 주소를 `PUBLIC_URL`에 지정합니다. OAuth 토큰은 이 주소에 묶입니다.

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

### 로컬 (stdio)

클라이언트가 서버를 직접 실행합니다. OAuth 로그인이 없고, 자격 증명은 클라이언트 설정의 환경 변수로 전달합니다.

표준 설정:

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

Docker로 실행하는 경우:

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

예약 발송, 분류 규칙, 부재중 응답은 서버 프로세스가 실행 중일 때만 동작합니다. 항상 동작해야 한다면 HTTP 방식을 사용합니다.

## 클라이언트 연결

### 원격 (HTTP)

엔드포인트는 `https://<호스트>/mcp`입니다. Streamable HTTP와 OAuth 2.1(동적 클라이언트 등록, PKCE)을 사용하므로 Client ID나 API 키는 필요하지 않습니다. 연결하면 로그인 화면이 열리고, 네이버 애플리케이션 비밀번호를 입력하면 연결이 완료됩니다.

<details>
<summary>ChatGPT</summary>

설정에서 개발자 모드를 켠 뒤 커스텀 커넥터를 추가하고, URL과 인증 방식(OAuth)을 입력합니다.
</details>

<details>
<summary>Claude (웹·데스크톱)</summary>

설정 → 커넥터 → 커스텀 커넥터 추가에서 URL을 입력합니다.
</details>

<details>
<summary>Claude Code</summary>

```bash
claude mcp add --transport http nmail https://<호스트>/mcp
```

이후 `/mcp`에서 로그인합니다.
</details>

<details>
<summary>Codex</summary>

```bash
codex mcp add nmail --url https://<호스트>/mcp
codex mcp login nmail
```
</details>

<details>
<summary>Cursor</summary>

`~/.cursor/mcp.json`:

```json
{ "mcpServers": { "nmail": { "url": "https://<호스트>/mcp" } } }
```
</details>

<details>
<summary>VS Code</summary>

`.vscode/mcp.json`:

```json
{ "servers": { "nmail": { "type": "http", "url": "https://<호스트>/mcp" } } }
```
</details>

### 로컬 (stdio)

<details>
<summary>Claude Desktop</summary>

`claude_desktop_config.json`에 [표준 설정](#로컬-stdio)을 추가합니다.
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

`~/.cursor/mcp.json`에 [표준 설정](#로컬-stdio)을 추가합니다.
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

클라이언트별 설정 위치와 메뉴 이름은 버전에 따라 다를 수 있습니다. 각 클라이언트 문서를 함께 확인하세요.

## 설정

| 변수 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `NAVER_ID` | 예 | | 네이버 아이디 (`@naver.com` 제외) |
| `NAVER_APP_PASSWORD` | 예 | | 네이버 애플리케이션 비밀번호. HTTP 방식에서는 OAuth 로그인 비밀번호로도 사용됩니다 |
| `NAVER_NAME` | | | 보내는 사람 이름 |
| `NAVER_SIGNATURE` | | | 서명 (`\n`으로 줄바꿈) |
| `PORT` | | `8787` | Node.js·Docker: 수신 포트 |
| `HOST` | | `127.0.0.1` (Docker: `0.0.0.0`) | Node.js·Docker: 수신 주소 |
| `DATA_DIR` | | `./data` (Docker: `/data`) | Node.js·Docker: 상태 저장 디렉터리 |
| `PUBLIC_URL` | | | Node.js·Docker: 외부 접속 주소. 없으면 `localhost`·`127.0.0.1`로 들어온 요청만 처리합니다 |
| `TRUST_PROXY` | | | Node.js·Docker: `1`이면 `X-Forwarded-*` 헤더를 신뢰. 클라이언트 IP는 `X-Forwarded-For`의 마지막 값을 사용 |

Cloudflare Workers에서는 `wrangler secret put`으로 앞의 네 값을 설정합니다.

## 도구

메일은 `{folder, uid}`로 지정합니다. 메일함 이름 대신 `inbox`, `sent`, `drafts`, `trash`, `spam`(또는 `받은메일함`, `보낸메일함` 등)을 사용할 수 있습니다.

<details>
<summary><b>찾기·읽기</b></summary>

| 도구 | 설명 |
|---|---|
| `search_emails` | 메일 검색. Gmail 검색어, 메일함 지정, 본문 키워드(`maxScan`, `resume`), 미리보기(`snippets`) |
| `read_email` | 메일 읽기. 기본 `text`는 최대 4,000자씩 반환하며 `nextOffset`을 `offset`에 넣어 이어 읽습니다. 링크 추출은 `includeLinks: true`로 요청합니다. `html`, `raw`, `headers` 형식도 지원합니다. |
| `get_thread` | 대화 전체를 시간순으로 조회 |
| `get_attachment` | HTTP에서는 5분짜리 원본 다운로드 링크를 제공합니다(Node.js·Docker 최대 100MB, Workers 최대 10MiB). 큰 첨부는 네이버 메일에서 직접 받으세요. PDF·PNG·JPEG·GIF·WebP·텍스트는 브라우저 미리보기를 지원합니다. |
| `find_contacts` | 주고받은 메일에서 연락처 검색 |
| `sender_stats` | 보낸 사람별 메일 수 |
</details>

<details>
<summary><b>보내기</b></summary>

| 도구 | 설명 |
|---|---|
| `send_email` | 새 메일 발송. 참조, 숨은참조, HTML, 첨부, 본문 삽입 이미지, 회신 주소, 중요도, 수신확인, 서명 |
| `reply_email` | 답장 또는 전체 답장. `asDraft`로 임시저장 |
| `forward_email` | 원래 첨부를 포함해 전달. `asDraft`로 임시저장 |
| `respond_to_invite` | 일정 초대 수락, 거절, 미정 (iCalendar REPLY) |
| `unsubscribe` | 원클릭 수신거부(RFC 8058) 또는 mailto 요청 |
</details>

<details>
<summary><b>임시보관함</b></summary>

| 도구 | 설명 |
|---|---|
| `save_draft` | 임시저장 |
| `list_drafts` | 임시보관함 목록 |
| `update_draft` | 일부 필드 수정 (첨부와 스레드 헤더 유지) |
| `send_draft` | 발송 후 임시보관함에서 삭제 |
</details>

<details>
<summary><b>정리</b></summary>

| 도구 | 설명 |
|---|---|
| `move_emails` | 메일함 이동 (`spam`: 스팸 신고, `inbox`: 복원) |
| `set_flags` | 읽음, 별표, 답장함 표시 |
| `delete_emails` | 휴지통으로 이동 또는 영구 삭제 |
| `bulk_action` | 검색 결과 일괄 처리. 사전 집계(`dryRun`)와 개수 확인(`expectedCount`) 필요, 영구 삭제 불가 |
| `manage_folder` | 메일함 생성, 이름 변경, 삭제 |
| `list_folders` | 메일함 목록과 메일 수 |
| `get_profile` | 계정 정보와 저장 용량 |
</details>

<details>
<summary><b>자동화</b></summary>

| 도구 | 설명 |
|---|---|
| `schedule_email` | 예약 발송 (시간대가 없으면 한국 시간) |
| `cancel_scheduled` | 예약 취소 |
| `create_rule` | 새 메일 분류 규칙: 읽음, 별표, 이동, 휴지통 |
| `delete_rule` | 규칙 삭제 |
| `set_vacation` | 부재중 자동 응답 (종료일 필수) |
| `list_automations` | 예약 메일, 규칙, 부재중 응답 상태 |
</details>

### 검색어

`search_emails`의 `query`는 Gmail 검색어 문법을 따르며, 모든 조건은 AND로 결합됩니다.

| 예 | 의미 |
|---|---|
| `결제 "카드 승인" -광고` | 낱말, 구문, 제외 |
| `from:shop@example.com`, `-from:spam` | 보낸 사람 |
| `to:` `cc:` `bcc:` `subject:` | 받는 사람, 제목 |
| `after:2026/11/01`, `before:2026/12/01` | 날짜 (한국 시간) |
| `newer_than:7d`, `older_than:1y` | 기간 (`d`, `w`, `m`, `y`) |
| `is:unread`, `is:starred`, `is:answered` | 상태 |
| `has:attachment`, `filename:pdf` | 첨부 |
| `larger:5M`, `smaller:100K` | 크기 |
| `in:sent`, `in:anywhere` | 메일함 |

지원하지 않는 연산자(`OR`, `category:` 등)는 결과의 `warnings`에 표시됩니다.

## 네이버 IMAP 호환성

네이버 IMAP 서버의 다음 동작에 맞춰 구현되어 있습니다.

| 서버 동작 | 처리 방식 |
|---|---|
| BODY/TEXT 검색 결과가 항상 비어 있음 | 제목·보낸 사람은 서버 검색, 본문은 메일 앞부분을 내려받아 비교 |
| HEADER 검색이 Message-ID에서만 동작 | Message-ID 조회와 제목 검색으로 스레드 구성 |
| OR와 HEADER 조합 결과가 비어 있음 | 헤더 검색을 개별 요청으로 분리 |
| UID가 계정 전체에서 공유되고 UIDNEXT가 실제 최댓값보다 작음 | 새 메일 감지에 실제 최대 UID 사용 |
| SMTP 발송 메일이 보낸메일함에 저장되지 않음 | 발송 후 보낸메일함에 직접 저장 |
| SORT, THREAD 확장 미지원 | 정렬과 스레드 구성을 서버에서 처리 |

## 리소스 사용량 (Cloudflare Workers)

Cloudflare 배포에서 `wrangler tail`로 측정한 요청당 CPU 시간입니다 (2026년 11월).

| 요청 | CPU (ms) |
|---|---:|
| OAuth 등록·인가·토큰 발급 | 3–6 |
| `tools/list` | 11–36 |
| `read_email` | 23–31 |
| `list_folders`, `get_profile` | 44–46 |
| `search_emails` | 41–59 |
| `get_thread` | 40 |
| `sender_stats`, `find_contacts` | 74–111 |

대부분의 요청이 Workers 무료 요금제의 요청당 CPU 한도(10ms)를 초과하므로 Workers Paid 요금제 사용을 권장합니다. Node.js와 Docker 실행에는 이 제한이 없습니다.

## 보안

- 네이버 자격 증명은 시크릿(Workers) 또는 환경 변수(Node.js·Docker)로 전달됩니다. KV·SQLite에는 OAuth 토큰, 자동화 상태, 5분간 유효한 다운로드 링크용 기록이 저장됩니다. 첨부 원본은 다운로드할 때 네이버 메일에서 가져옵니다.
- OAuth 로그인 화면은 권한을 받을 대상을 표시하고, 알려지지 않은 웹 주소일 경우 경고합니다. 로그인 시도는 IP당 분당 5회로 제한됩니다.
- 메일 본문은 신뢰할 수 없는 입력으로 취급해야 합니다. 도구 설명에서 발송·삭제 전 사용자 확인을 요구하지만 서버에서 강제하지는 않으므로, 클라이언트의 도구 실행 확인 기능을 사용하는 것이 좋습니다.
- 자동 전달 규칙은 지원하지 않습니다.
- `bulk_action`은 영구 삭제를 지원하지 않으며, 사전 집계 결과와 실행 시점의 개수가 다르면 실행을 거부합니다.
- 부재중 응답은 RFC 3834를 따르며 메일링 리스트, 자동 발송 메일, 본인 주소에는 응답하지 않습니다.
- Node.js에서는 내부망 요청 차단 장치가 없으므로 URL 형식의 OAuth Client ID(CIMD)를 사용하지 않고 동적 클라이언트 등록만 허용합니다.

## 개발

```bash
npm install
cp .dev.vars.example .dev.vars   # NAVER_ID, NAVER_APP_PASSWORD
```

| 명령 | 설명 |
|---|---|
| `npm run dev` | Workers 로컬 서버 (`http://localhost:8787/mcp`) |
| `npm run build` | Node.js 번들 생성 (`dist/nmail-mcp.mjs`) |
| `npm start` | Node.js 서버 실행 |
| `npm test` | 단위 테스트 |
| `npm run typecheck` | 타입 검사 |
| `npm run e2e` | 실제 계정 통합 테스트. 실행 중인 서버가 필요하며(`BASE`로 주소 지정) 본인 주소로만 발송하고 종료 시 테스트 메일을 삭제 |
| `node test/stdio.mjs` | stdio 모드 확인 |
| `npm run bench` | 도구별 CPU 측정 (Node.js) |

| 경로 | 내용 |
|---|---|
| `src/index.ts` | Workers 진입점, OAuth, 크론 |
| `src/node/` | Node.js 진입점 (`serve`, `stdio`), SQLite KV |
| `src/auth.ts` | OAuth 로그인 화면 |
| `src/tools.ts` | MCP 도구 정의 |
| `src/imap.ts`, `src/smtp.ts` | IMAP, SMTP 클라이언트 |
| `src/mime.ts` | 문자셋, 인코딩, HTML 변환, 첨부 구분, iCalendar |
| `src/mail.ts`, `src/read.ts`, `src/send.ts`, `src/organize.ts` | 메일함, 읽기, 보내기, 정리 |
| `src/search.ts` | 검색, 스레드, 통계 |
| `src/automation.ts` | 예약 발송, 분류 규칙, 부재중 응답 |

## 제한 사항

- 원본 메일을 기준으로 스레드를 조회하면 제목이 변경된 답장이 포함되지 않을 수 있습니다. 답장을 기준으로 조회하면 원본이 포함됩니다.
- 본문 키워드 검색은 메일당 앞부분(텍스트 6KB, HTML 18KB)만 확인합니다.
- Cloudflare Workers에서는 크론 실행이 겹치는 경우 예약 메일이 중복 발송될 수 있습니다.
- 분류 규칙이나 부재중 응답이 활성화되어 있으면 5분마다 IMAP에 로그인합니다.

## 라이선스

[Apache License 2.0](LICENSE)
