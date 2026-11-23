# nmail-mcp

네이버 메일을 ChatGPT(및 Claude 등 원격 MCP 클라이언트)에 연결하는 1인용 MCP 서버. Cloudflare Workers에서 IMAP/SMTP로 동작한다.

- 전송: Streamable HTTP `/mcp` (stateless, `agents/mcp/server`의 `createMcpHandler`)
- 인증: OAuth 2.1 (`@cloudflare/workers-oauth-provider`, DCR·PKCE·CIMD). 로그인 화면의 비밀번호 = 시크릿에 넣은 **네이버 애플리케이션 비밀번호**
- 메일: IMAP `imap.naver.com:993`(직접 구현한 경량 클라이언트 `src/imap.ts`), SMTP `smtp.naver.com:465`(직접 구현, nodemailer 전송은 workerd에서 연결 실패), MIME 생성 nodemailer `MailComposer`, 전체 파싱이 필요한 곳(답장·전달·임시보관함)만 postal-mime
- 자동화: Cron Trigger (매분: 예약 발송 / 5분마다: 분류 규칙·부재중 응답)

## 도구 (28개)

| 분류 | 도구 |
|---|---|
| 계정·메일함 | `get_profile`(용량 포함), `list_folders`, `manage_folder` |
| 찾기·읽기 | `search_emails`, `read_email`, `get_thread`, `get_attachment`, `find_contacts`, `sender_stats` |
| 보내기 | `send_email`, `reply_email`, `forward_email`, `respond_to_invite`, `unsubscribe` |
| 임시보관함 | `save_draft`, `list_drafts`, `update_draft`, `send_draft` |
| 정리 | `move_emails`, `set_flags`, `delete_emails`, `bulk_action` |
| 자동화 | `schedule_email`, `cancel_scheduled`, `create_rule`, `delete_rule`, `set_vacation`, `list_automations` |

- **검색**: Gmail식 검색어(`from:` `to:` `cc:` `bcc:` `subject:` `"구문"` `-제외` `-from:` `after:/before:` `newer_than:/older_than:` `is:unread|read|starred|answered` `has:attachment` `filename:` `larger:/smaller:` `in:폴더|anywhere`)와 개별 필드를 AND로 결합. 기본은 휴지통·스팸·임시보관함을 뺀 모든 메일함. `snippets: true`면 결과마다 본문 미리보기. 지원하지 않는 연산자(`OR`, `category:` 등)는 `warnings`로 알려 준다.
- **본문 검색**: 네이버 IMAP의 BODY/TEXT 검색은 항상 0건을 돌려준다(실측). 그래서 키워드는 제목·보낸사람은 서버 검색으로, 본문은 메일 텍스트를 직접 받아 비교한다. 받는 양에 상한(`maxScan`, 기본 25통)과 시간 상한이 있고, 다 못 보면 `complete: false`로 알려 준다(예산을 넘은 뒤에도 제목·보낸사람 일치는 계속 찾는다).
- **대화**: 네이버는 HEADER 검색이 Message-ID에만 동작한다(References·In-Reply-To는 0건, 실측). 그래서 Message-ID로 이전 메일을, 같은 제목으로 이후 메일을 찾은 뒤 References/In-Reply-To로 실제 연결된 것만 묶는다. 제목을 바꾼 답장은 놓칠 수 있다.
- **읽기**: 원문(.eml)·전체 헤더 보기, 링크 목록, SPF/DKIM/DMARC 결과, 수신거부 정보, 일정 초대(.ics) 해석
- **첨부**: 이미지는 이미지 콘텐츠로(ChatGPT가 직접 봄), 텍스트는 텍스트로, 나머지는 파일로. 다른 메일의 첨부를 그대로 붙여 보내기(`attachFrom`)
- **보내기 옵션**: 참조·숨은참조, HTML, 본문 삽입 이미지(`contentId`), 회신 주소, 중요도, 수신확인 요청, 서명(`NAVER_SIGNATURE`), 답장·전달을 임시저장으로(`asDraft`)
- **일괄 처리**: `bulk_action`은 먼저 `dryRun`으로 개수를 확인하고, 실행할 때 그 개수(`expectedCount`)가 달라졌으면 서버가 거부한다. 영구 삭제는 일괄 처리에 없다.
- **수신거부**: RFC 8058 원클릭(POST, 리디렉션 따르지 않음) → mailto 발송 → 둘 다 없으면 링크만 돌려준다.
- **자동화**
  - 예약 발송: 시각에 오프셋이 없으면 한국 시간. 보내기 직전에 `sending`으로 표시하고 그 상태에서는 다시 보내지 않는다(중복 발송 방지).
  - 분류 규칙: 새로 온 받은메일함 메일만 대상(켜는 순간의 최신 메일부터 감시). 읽음·별표·이동·휴지통. **자동 전달은 일부러 없다**(메일 속 지시문에 속은 AI가 전달 규칙을 만들면 메일이 계속 새기 때문).
  - 부재중 응답: 종료일 필수, 같은 사람에게는 N일에 한 번. RFC 3834에 따라 메일링 리스트·no-reply·자동응답·내 주소에는 답하지 않고, `Auto-Submitted: auto-replied`를 붙인다.

## 코드 구조

| 파일 | 역할 |
|---|---|
| `src/index.ts` | Worker 진입점: OAuth 래핑, 크론 |
| `src/auth.ts` | 로그인(동의) 화면, 비밀번호 확인, 시도 제한 |
| `src/tools.ts` | MCP 도구 정의(모듈 로드 때 한 번 생성, JSON Schema 미리 변환) |
| `src/imap.ts` | IMAP 클라이언트: 응답 토크나이저, ENVELOPE/BODYSTRUCTURE 해석, 수정 UTF-7 |
| `src/smtp.ts` | SMTP 클라이언트(465, AUTH PLAIN) |
| `src/mime.ts` | 문자셋·인코딩 단어·전송 인코딩 해제, HTML→텍스트, 첨부 구분, .ics |
| `src/mail.ts` | 계정, IMAP 세션, 메일함(별칭·역할·캐시), 프로필 |
| `src/read.ts` | 읽기(필요한 부분만), 첨부 받기 |
| `src/send.ts` | 작성·발송, 답장·전달, 임시보관함, 일정 회신, 수신거부 |
| `src/organize.ts` | 이동·표시·삭제 (여러 메일함에 걸쳐) |
| `src/search.ts` | 검색어 해석, 검색 엔진(본문 스캔 예산), 대화 묶기, 통계·연락처 |
| `src/automation.ts` | 예약 발송, 분류 규칙, 부재중 응답 (크론) |

## 저장되는 것

- Worker 시크릿: 네이버 아이디, 애플리케이션 비밀번호, (선택) 보내는 이름·서명
- KV(`OAUTH_KV`): OAuth 토큰, 그리고 `app:` 접두사로 예약 메일 원문(보낸 뒤 삭제)·분류 규칙·부재중 설정·부재중 응답 기록(30일)·새 메일 감시 위치

## 네이버 준비

1. 네이버 ID → 보안설정 → **2단계 인증** 켜기
2. 2단계 인증 → 관리 → **애플리케이션 비밀번호** 생성
3. 네이버 메일 → 환경설정 → POP3/IMAP 설정 → **IMAP/SMTP 사용: 사용함**

## 로컬 실행·검증

```bash
npm install
cp .dev.vars.example .dev.vars   # NAVER_ID, NAVER_APP_PASSWORD 채우기
npm run dev                      # http://localhost:8787/mcp (크론 시험용 --test-scheduled 포함)
npm test && npm run typecheck    # 단위 테스트
npm run e2e                      # 실제 계정 종합 시험(68항목): 내 주소로만 보내고 끝나면 모두 영구 삭제
npm run bench                    # 도구별 CPU 측정 (서버 없이 Node에서; ONLY=<정규식>으로 골라 실행)
node test/client.mjs call search_emails '{"query":"is:unread","limit":3}'   # 도구 하나 직접 호출
```

## 배포

```bash
npx wrangler login
npx wrangler secret put NAVER_ID
npx wrangler secret put NAVER_APP_PASSWORD
npx wrangler secret put NAVER_NAME        # 선택: 보내는 사람 이름
npx wrangler secret put NAVER_SIGNATURE   # 선택: 서명 (줄바꿈은 \n)
npm run deploy                            # OAUTH_KV는 첫 배포 때 자동 생성 (wrangler 4.158 기본 동작), 크론도 함께 등록
```

자동 생성이 안 되면 `npx wrangler kv namespace create OAUTH_KV`로 만든 id를 `wrangler.jsonc`의 `kv_namespaces`에 `"id"`로 넣고 다시 배포한다.

**요금제와 CPU**: Workers 무료 요금제는 요청당 CPU 10ms다(가끔 넘는 것은 봐주지만 계속 넘으면 중단). 무료에 맞추려고:

- IMAP 클라이언트를 직접 구현(imapflow는 로그인에만 7~20ms), 번들 3.5MB → 2.0MB
- 도구 스키마를 시작 단계에서 한 번만 변환(`tools/list` 9.4ms → 1ms 안팎)
- 읽기는 필요한 부분만 받음(전체 메일 파싱 안 함), 여러 메일함 검색은 날짜만 받아 정렬 후 결과 페이지만 상세 조회
- 본문 검색은 기본 25통·통당 앞 6KB, 통계·연락처는 기본 150통, 미리보기는 요청할 때만
- 메일함 목록은 격리 단위로 5분 캐시

로컬(Node) 측정 CPU, ms (`npm run bench`, 2026-11-24). **추정치이며 Cloudflare에서 실측하지 않았다.**

- **첫 호출**: 프로세스에서 처음 실행할 때(JIT 전). 한 사람이 가끔 쓰는 서버는 새 격리(cold)에서 도는 일이 많아 이 값에 가깝다.
- **최소·중앙값**: 같은 프로세스에서 반복했을 때(warm).
- Node 수치에는 workerd가 네이티브로 처리하는 TLS(연결당 3~5ms)가 들어 있어 실제보다 크게 나올 수 있다. 반대로 workerd에서 JS가 더 느릴 수도 있어 어느 쪽으로든 단정할 수 없다.

| 도구 | 처음(imapflow, 중앙값) | 지금 첫 호출 | 지금 최소 | 지금 중앙값 | 10ms 안에 들 가능성 |
|---|---:|---:|---:|---:|---|
| `tools/list` | 9.4 | 18.5 | 0.8 | 1.4 | warm이면 높음, cold면 넘음 |
| `list_drafts` | 9.9 | 4.8 | 4.0 | 4.7 | 높음 |
| `read_email` (작은 메일) | 15.0 | 7.6 | 4.9 | 6.0 | 높음 |
| `read_email` (큰 HTML) | 16.1 | 6.5 | 6.4 | 6.8 | 높음 |
| `get_profile` | 15.3 | 21.1 | 4.6 | 6.2 | warm이면 높음, cold면 넘음 |
| 받은메일함 검색 (미리보기 없음) | 16.1 | 9.0 | 7.8 | 8.7 | 경계 |
| `list_folders` | 20.7 | 12.2 | 9.9 | 11.4 | 경계 |
| `get_thread` | 28.2 | 16.8 | 14.4 | 14.9 | 넘을 가능성 높음 |
| `subject:` 검색 (전체 메일함) | 25.5 | 14.8 | 14.4 | 16.4 | 넘을 가능성 높음 |
| 전체 메일함 검색 | 66.8 | 20.2 | 16.7 | 18.7 | 넘을 가능성 높음 |
| 받은메일함 검색 + 미리보기 | 52.4 | 31.1 | 16.7 | 20.0 | 넘을 가능성 높음 |
| 본문 키워드 검색 (25통) | 210.8 | 30.7 | 30.6 | 30.7 | 넘음 |
| `sender_stats` (150통) | 463.3 | 39.9 | 39.9 | 42.6 | 넘음 |

보내는 쪽(메일 만들기, 네트워크 제외, 최소): 텍스트만 1.3 · 첨부 100KB 3.1 · 1MB 5.7 · 5MB 11.7. 여기에 SMTP 접속과 보낸메일함 저장이 더해지므로, **첨부가 큰 발송은 10ms를 넘을 가능성이 높다.**

정리하면 무료 요금제에서는 읽기·임시보관함처럼 메일 한 통을 다루는 작업만 대체로 들어갈 것으로 보이고, 검색·대화 묶기·통계·큰 첨부 발송은 자주 넘을 것이다. Cloudflare는 가끔 넘는 것은 봐주지만 계속 넘으면 요청을 중단한다. 이런 기능을 자주 쓰면 Workers Paid($5/월, 요청당 CPU 기본 30초)를 권한다.

배포 후 실제 값 확인: `npx wrangler tail`에서 `Exceeded CPU Limit`(결과 `exceededCpu`)가 나오는지 보고, 요청별 CPU 시간은 Cloudflare 대시보드의 Workers 지표에서 본다. (`wrangler tail` 출력에 요청별 CPU 시간이 들어 있는지는 확인하지 않았다.)

배포 후 첫 호출은 `list_folders`로 해 본다. 네이버가 Cloudflare IP에서 오는 로그인을 막는지는 아직 확인하지 않았다.

## ChatGPT 연결

ChatGPT 설정에서 **개발자 모드**를 켠 뒤 커스텀 커넥터(앱)를 추가한다 (메뉴 이름은 바뀔 수 있다. 개발자 모드는 유료 요금제 필요).
- MCP 서버 URL: `https://nmail-mcp.<계정>.workers.dev/mcp`
- 인증: OAuth (클라이언트 자동 등록을 지원하므로 Client ID는 비워 둔다)
- 뜨는 로그인 화면에 애플리케이션 비밀번호 입력

연결을 끊으려면 네이버에서 애플리케이션 비밀번호를 삭제한다(새로 만들면 `wrangler secret put NAVER_APP_PASSWORD`로 교체).

## 주의

- 메일 본문은 신뢰할 수 없는 데이터다. 메일 속 지시문으로 AI가 메일을 보내거나 지우지 않도록, ChatGPT의 쓰기 도구 확인을 켜 둘 것.
- 로그인 시도는 IP당 분당 5회로 제한된다.
- 분류 규칙이나 부재중 응답이 켜져 있으면 5분마다 IMAP에 로그인한다(꺼져 있으면 로그인하지 않음).
- 본문 키워드 검색은 메일 본문을 직접 받아 보므로 몇 초 걸린다. 날짜·메일함을 좁히면 빨라진다.
- KV는 잠금이 아니다. 크론 실행이 겹치는 드문 경우 예약 메일이 두 번 나갈 가능성이 이론상 있다.
- 짧은 시간에 로그인을 많이 하면 네이버가 잠시 연결을 늦추는 것으로 보인다(시험 중 ETIMEDOUT 1회). 연결 오류는 한 번 자동 재시도한다.
