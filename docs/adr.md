# ADR 로그 — 기술 결정과 교체 조건

> 기획서 부록 B 를 **갱신되는 문서**로 옮긴 것. 기술 조건이 추가되면 여기부터 본다.

기획서(`docs/기획서-v2.md`)는 고정 문서다. 부록 B 의 A1~A13 은 v2 작성 시점(2026-07-25)에 박제된 상태로 남는다.
**이 파일이 그 이후의 진실이다.** 두 문서가 어긋나면 이 파일이 이긴다.

## 이 파일을 고치는 절차 (기획서 0장)

1. 해당 ADR 의 "다시 보게 만드는 조건" 열을 본다. 변경이 거기 해당하는가.
2. 해당하면 그 줄의 **상태를 `superseded` 로 바꾸고 새 번호를 아래에 추가한다.** 기존 줄을 지우지 않는다.
   지우면 "왜 그때 그렇게 했는가"가 사라지고 같은 논쟁을 다시 한다.
3. "영향받는 곳"에 적힌 장절과 파일만 고친다.
4. 기획서 Part I(1~6장)을 고쳐야 한다는 결론이 나오면 그건 기술 변경이 아니라 제품 변경이다. 문서 버전을 v3 로 올린다.

**기술 변경은 코드보다 ADR 이 먼저다.** 순서를 뒤집으면 다른 트랙이 조용히 깨진다.

## 상태 표기

| 상태 | 뜻 |
|---|---|
| `accepted` | 현재 유효. 코드가 이 결정을 따르고 있다 |
| `superseded` | 다른 ADR 로 대체됨. "다시 보게 만드는 조건"이 실제로 발생한 것 |
| `proposed` | 결정했지만 코드에 아직 반영되지 않음 |

---

## A1~A13 — 기획서 부록 B 승계

날짜는 전부 2026-07-25(기획서 v2 작성일)다. 이번 스캐폴딩에서 상태가 바뀐 것만 비고에 적었다.

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A1** | LLM 은 컴파일 시에만 호출 | `accepted` | 비용·속도·재현성. P6 무료 티어 제약 | 실시간 파싱이 필요한 요구(매 요청마다 다른 스키마)가 생기면 | 기획서 7장①·8장·9장, `apps/worker` |
| **A2** | 어댑터는 코드가 아니라 선언적 JSON 스펙 | `accepted` | 샌드박스 비용 0, 검증·롤백·치유가 쉬움 | 변환 연산자로 표현 불가능한 사이트가 **반복적으로** 나오면 → 먼저 연산자 추가로 대응, 그래도 안 되면 재검토 | 기획서 7장②·11장, `packages/core/src/spec` |
| **A3** | probe 순서: 인라인 JSON → 네트워크 관찰 → DOM 구조 → 브라우저 렌더 | `accepted` | 싼 것부터. 내부 API 가 가장 안정적 | 대상 사이트군이 SPA 위주로 바뀌면 브라우저를 앞으로 | 기획서 9-1, G1 강등 규칙, `apps/worker` |
| **A4** | 부분 성공을 응답에 싣는다 | `accepted` | 소스 하나가 전체를 죽이지 않게 | 없음 — 제품 원칙에 가깝다 | 기획서 7장④·12장, `packages/core/src/query/respond.ts` |
| **A5** | TypeScript 단일 언어 | `accepted` | 스키마 타입이 프론트·워커·API·MCP 를 관통 | 팀에 Python 강점이 있고 파싱 라이브러리가 결정적이 되면 | 모노레포 구조 전체 |
| **A6** | PostgreSQL 하나 + JSONB (별도 검색엔진 없음) | `accepted` | 5일 규모에서 검색엔진은 부채 | 아이템이 수백만 건이 되거나 한국어 형태소 검색이 필수가 되면 | 기획서 10장·12장 `?q=`, `packages/core/src/db/schema.ts`, `query/build.ts` |
| **A7** | Drizzle ORM | `accepted` | 마이그레이션 사이클이 짧음 | 팀이 Prisma 에 훨씬 익숙하면 (이 규모에서 기능 차이는 없음) | `packages/core/src/db` — 드라이버 선택은 **A23** |
| **A8** | BullMQ + Redis | `accepted` | repeatable job 이 크론·재시도·rate limit 을 한 번에 해결 | 워커가 1대로 충분하고 Redis 가 부담이면 pg-boss 로 (Postgres 만 씀) | 기획서 9-3·9-4, `apps/worker` |
| **A9** | 단일 VM + Docker Compose + Caddy | `accepted` | P5. Playwright 실행에 시간·메모리 제약이 없어야 함 | 트래픽이 VM 1대를 넘거나 브라우저 워커를 분리해야 하면 | 기획서 8장 배포, `deploy/` — 로컬 분리는 **A25** |
| **A10** | 인증: Auth.js + Google 단일 / 공개 API 는 컬렉션별 키 | `accepted` | P4. 로그인 화면을 하나로 | 다른 소셜 로그인이나 팀 계정 요구가 생기면 (6장에서 제외한 범위) | `packages/core/src/db/schema.ts` (Auth.js 4종), `apps/web` |
| **A11** | 구독 채널은 인터페이스로 추상화, 웹훅 먼저 | `accepted` | P7. 발송 도메인 문제를 뒤로 미룸 | 이메일이 주 채널이 되면 SPF/DKIM 설정이 선행 작업으로 올라옴 | 기획서 9-4, G3/G4, `packages/core/src/types/subscription.ts` |
| **A12** | 페이지네이션 상한 3페이지 | `accepted` | 5일 범위에서 무한 크롤 금지 | 사용자가 전체 이력을 원하면 (6장에서 제외한 범위) | 기획서 11장 `max_pages`, `spec/spec.ts` (파싱 단계에서 거부) |
| **A13** | 신규 판정은 `(source_id, external_key)` 의 최초 등장 | `accepted` | 구독의 "새 항목만"이 여기 걸려 있음 | `external_key` 가 불안정한 사이트가 다수가 되면 콘텐츠 기반 지문으로 | 기획서 10장·9-3·15장, `spec/interpret.ts`(`ExternalKeyOrigin`), `db/seed.ts` 멱등성 |

---

## A14~ — 스캐폴딩(G0)에서 새로 생긴 결정

날짜는 전부 2026-07-26 이다.

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A14** | LLM 모델을 `gemini-3.1-flash-lite` 하나로 통일. 기획서 8장의 pro/flash 배분표는 폐기 | `accepted` | `gemini-2.5-pro` 는 무료 티어 쿼터가 사실상 0 이고, `2.5-flash`/`-lite` 는 종료 예정이다. 3.x 세대에 무료 pro 는 없다. **P6(무료 티어)이 유지되는 한 선택지가 하나뿐이다** | 유료 키를 쓰게 되거나, 컴파일 품질이 lite 로 부족하다고 G1 에서 판정되면 | 기획서 8장 모델 배분표(무효), `.env.example`, `packages/core/src/env.ts`, `apps/worker` 컴파일·치유 |
| **A15** | `packages/core` 를 **빌드 없이 소스 그대로** 소비한다 | `accepted` | 5일에서 워치·빌드 순서 관리는 순수한 손실이다. `dist/` 가 없으면 "빌드를 안 돌려서 옛 타입을 보고 있었다" 라는 사고가 구조적으로 불가능하다 | core 를 워크스페이스 밖에서 쓰게 되거나, 배포 이미지가 소스 트리를 담기 싫어지면 | `packages/core/package.json` (`exports` 가 `./src/*.ts`), `tsconfig.base.json` (`noEmit`), `apps/web` (`transpilePackages`), worker·mcp (tsx) |
| **A16** | Next 16 · React 19 · Tailwind 4 (CSS-first, `tailwind.config.js` 없음) | `accepted` | 기획서는 Next 15 + Tailwind 3 이었으나 스캐폴딩 시점의 최신 안정판이 16/4 다. 5일짜리 신규 프로젝트에서 한 세대 뒤처진 버전을 고르면 문서·예제가 안 맞는다. Turbopack 이 기본이라 dev 기동도 빠르다 | Tailwind 4 의 CSS-first 설정으로 표현이 안 되는 테마 요구가 나오거나, 라이브러리가 Next 16 을 아직 지원하지 않으면 | 기획서 8장 스택표, `apps/web/package.json`, `apps/web/app/globals.css`(`@import 'tailwindcss'`), PostCSS 설정 |
| **A17** | shadcn/ui 를 쓰지 않고 **최소 자체 컴포넌트**를 둔다 | `accepted` | shadcn 은 Radix 의존 트리와 생성 파일을 같이 들고 온다. 필요한 것은 버튼·배지·표 몇 개뿐이고, Tailwind 4 조합에서 생성기를 맞추는 비용이 직접 쓰는 비용보다 크다. `clsx` + `tailwind-merge` + `lucide-react` 만 남긴다 | 다이얼로그·드롭다운·콤보박스처럼 접근성 처리가 까다로운 것이 세 개 이상 필요해지면 (그때는 Radix 만 직접 넣는다) | 기획서 8장 스택표, `apps/web/components` |
| **A18** | core 는 cheerio 를 모른다. HTML 평가를 **`HtmlAdapter` 주입점**으로 뺀다 | `accepted` | 해석기는 화면 미리보기와 워커 수집이 **같은 코드**여야 한다(기획서 8장). core 가 cheerio 를 직접 import 하면 브라우저 번들에 파서가 딸려 간다. 주입으로 바꾸면 테스트가 가짜 구현으로 돌고, 그게 곧 독립성의 증명이다 | 브라우저에서도 cheerio 를 쓰기로 하거나, DOM 평가에 어댑터로 못 감싸는 기능(예: 계산된 스타일)이 필요해지면 | `packages/core/src/spec/paths.ts`(`HtmlAdapter`), `spec/interpret.ts`(`InterpretContext.html`), `apps/worker`(cheerio 구현 주입) |
| **A19** | 상태 컬럼은 `pgEnum` 이 아니라 `text().$type<...>()` | `accepted` | 값 하나 늘릴 때마다 `ALTER TYPE` 마이그레이션을 도는 것은 5일 규모에서 부채다. 값 집합은 TS 유니온과 zod 가 지킨다 — 어차피 **G0 계약 #5 로 고정**된 집합이라 DB 가 한 번 더 지킬 실익이 적다 | 애플리케이션 밖(수동 SQL·BI 도구)에서 쓰기가 생기거나, 잘못된 상태 값이 실제로 들어가는 사고가 나면 | `packages/core/src/db/schema.ts`, 기획서 10장 |
| **A20** | worker · mcp 를 **번들 없이 `tsx` 로 실행**한다 | `accepted` | A15 의 따름 결정. 두 앱 다 서버 프로세스라 번들이 주는 이득이 없고, 소스 그대로 도는 편이 스택 트레이스가 정직하다. `tsx watch` 가 곧 dev 서버다 | 배포 이미지 크기나 기동 시간이 실제로 문제가 되면 (그때 `tsup`/`esbuild` 를 붙인다) | `apps/worker/package.json`, `apps/mcp/package.json`, `deploy/` Dockerfile |
| **A21** | zod 4 를 **스펙·환경변수·쿼리 파라미터의 단일 검증기**로 쓴다 | `accepted` | 기획서 11장의 "스펙 검증은 프롬프트 신뢰가 아니라 계약 검사"를 실체화한 것. 같은 zod 스키마가 (1) LLM 구조화 출력의 JSON Schema, (2) 저장 전 검증, (3) 시드 검증을 전부 담당한다. 정의가 한 군데다 | zod 스키마에서 뽑은 JSON Schema 를 Gemini 가 거부하는 사례가 나오면 (그때는 JSON Schema 를 손으로 쓰고 zod 와 대조하는 테스트를 둔다) | `packages/core/src/spec/ops.ts`·`spec.ts`·`json-schema.ts`, `src/env.ts`, `src/query/params.ts` |
| **A22** | REST 와 MCP 가 **같은 쿼리 코드**(`@endpointer/core/query`)를 쓴다 | `accepted` | 두 표면이 12장 파라미터 표를 각자 구현하면 반드시 갈라지고, 갈라지는 순간 "내 API 하나"라는 제품 약속이 거짓말이 된다. `parseCollectionQuery` → `planItemsQuery` → `buildCollectionResponse` 세 단계를 둘이 공유한다 | MCP 도구가 REST 에 없는 질의(예: 벡터 검색)를 갖게 되면 | `packages/core/src/query/*`, `apps/web/app/api/v1/[collection]/route.ts`, `apps/mcp` |
| **A23** | DB 드라이버는 `postgres.js` (`pg` 아님) | `accepted` | ESM 네이티브고 타입이 좋다. Drizzle 의 `postgres-js` 어댑터가 1급 지원이며 마이그레이터도 같은 드라이버를 쓴다. 커넥션 풀 설정이 한 줄이다 | 커넥션 풀 동작이나 `LISTEN/NOTIFY` 에서 `pg` 가 필요해지면 | `packages/core/src/db/client.ts`, `db/migrate.ts` |
| **A24** | 개발 런타임은 **Node 24**, `engines` 는 `>=22` | `accepted` | 기획서는 22 LTS 였으나 설치된 것이 24.13.0 이고 Playwright·MCP SDK·BullMQ 가 전부 지원한다. `engines` 를 `>=22` 로 열어 두어 배포 이미지가 22 여도 깨지지 않게 한다 | 어떤 의존성이 24 에서만 깨지거나, 배포 베이스 이미지가 22 로 고정되면 | 기획서 8장, 루트 `package.json` `engines`, `deploy/` 베이스 이미지 |
| **A25** | 로컬 `docker-compose.yml` 은 **인프라(postgres·redis)만**. 앱은 호스트에서 `pnpm dev` | `accepted` | 개발 중 앱까지 컨테이너에 넣으면 HMR·tsx watch 가 느려지고 Playwright 디버깅이 어려워진다. 배포용 전체 구성(web·worker·mcp·caddy)은 `deploy/docker-compose.prod.yml` 로 분리한다 | 로컬과 배포의 차이 때문에 "내 컴퓨터에서는 됐는데"가 실제로 발생하면 | 루트 `docker-compose.yml`, `deploy/`, 루트 `package.json` `infra:*` 스크립트 |
| **A26** | 보장선 B2(내부 명사 금지)를 **테스트로 강제**한다 | `accepted` | 기획서 15장이 "보장선이 조용히 무너짐"을 리스크로 꼽았다. 급할 때 붙인 상태 문구 한 줄이 보장선을 깨고, 사람 눈으로만 지키면 G4 전수 점검에서야 발견된다. 문자열 규약은 기계가 잡을 수 있는 유일한 보장선이므로 잡는다 | 오탐이 잦아 개발이 막히면 (그때는 패턴을 좁히지, 테스트를 끄지 않는다) | `apps/web/lib/guardrails.ts`, `guardrails.test.ts`, `docs/guardrails.md` |

## A27~ — G1 작업 중 생긴 결정

날짜는 2026-07-27 이다.

> ⚠️ **A27 은 코드가 먼저 들어갔다.** 절차(ADR 먼저)를 어긴 것이라 여기 적어 둔다.
> 되돌릴 수 있는 결정이므로 남긴다.

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A27** | 나가는 요청은 **fetch 계층의 관문**에서 이름을 풀어 검사하고, 리다이렉트 **홉마다** 다시 검사한다. 확인된 IP 로 접속을 고정하지는 **않는다** | `superseded` (→ A41) | 이 제품은 사용자가 준 주소를 서버가 대신 연다 — 임의 URL 을 받는 것이 기능이므로 SSRF 는 부수 위험이 아니라 **기능의 이면**이다. 검사를 스펙 검증(`validateSpec`)에만 두면 probe 는 스펙이 생기기 **전에** 나가므로 아무것도 못 막는다. 이름만 보는 검사는 `evil.example → 127.0.0.1` 을 못 막아 이름 풀기가 필요하고, 첫 주소만 보면 302 한 번에 뚫려 홉마다 검사가 필요하다. IP 고정은 Node 내장 fetch 로 불가능해(undici 직접 의존) 지금 범위 밖이다 | ① DNS 리바인딩이 실제 위협이 되면 → undici 를 의존에 넣고 `lookup` 고정 (그때는 새 ADR). ② `apps/web`·`apps/mcp` 가 서버에서 임의 주소를 열게 되면 → 관문을 `packages/core` 로 올려야 한다 (지금은 worker 안에만 있다) | `apps/worker/src/fetchers/guard.ts`, `fetchers/http.ts`(수동 리다이렉트), `fetchers/browser.ts`·`probe/network.ts`(라우트 훅), `jobs/channels/webhook.ts`, `packages/core/src/spec/validate.ts`(`isPrivateHost`), `.env.example`(`ALLOW_PRIVATE_HOSTS`) |
| **A28** | 응답 본문의 인코딩은 **BOM → 헤더 → `<meta>`(앞 4KB) → UTF-8** 순으로 정한다. 판정은 `TextDecoder` 에게 맡기고 별도 인코딩 목록을 들지 않는다 | `accepted` | `res.text()` 는 헤더의 charset 만 본다. 한국 공공·협회 목록에는 헤더에 charset 을 안 적고 `<meta charset="euc-kr">` 로만 적은 곳이 아직 있다(korcham.net 으로 재현). 이때 **목록은 정상적으로 뚫리고 겹침률도 100% 가 나온다** — 화면 텍스트도 같이 깨져 둘이 일치하기 때문이다. 즉 우리가 가진 어떤 품질 신호에도 안 걸리는 **조용한 실패**라서, 사후 탐지가 아니라 받는 지점에서 막아야 한다. 순서를 브라우저와 같게 두는 이유는 사이트들이 브라우저에서 보이는 대로 만들어졌기 때문이다 | ① 헤더가 `iso-8859-1` 인데 `<meta>` 가 EUC-KR 인 사이트가 나오면 → 브라우저는 헤더를 따르지만 우리는 `<meta>` 를 택할지 다시 판단한다(그런 주소를 아직 못 잡아 지금은 브라우저와 같게 뒀다). ② 인코딩 자동 판별(문자 빈도 추정)이 필요해지면 → 의존성이 생기므로 새 ADR | `apps/worker/src/fetchers/charset.ts`, `fetchers/http.ts`(`HttpResponse.charset`), `probe/static.ts`·`probe/index.ts`(단계 기록에 표시) |
| **A29** | 앱의 `.env` 로딩은 **별도 모듈**(`load-env.ts`)에 두고 진입점의 **첫 import** 로 부른다 | `accepted` | ESM 은 `import` 선언을 전부 본문 코드보다 먼저 평가한다. 진입점 안에서 `loadDotenv()` 를 맨 위에 적어도, 아래에 있는 `@endpointer/core/db` 가 **먼저** 평가되면서 모듈 최상단에서 `DATABASE_URL` 을 읽다 죽는다. 실제로 `apps/mcp` 가 이 이유로 `pnpm dev:mcp` 에서 부팅조차 못 했다. 모듈로 빼면 ESM 이 import 선언 순서대로 의존 모듈을 평가하므로 순서가 보장된다 | 앱이 늘어나면 같은 파일을 복사하게 된다 → 세 번째 앱이 생기면 `packages/core` 로 올린다 | `apps/mcp/src/load-env.ts`, `apps/mcp/src/index.ts`. (`apps/worker` 는 `config.ts` 가 우연히 같은 역할을 하고 있어 지금은 무사하나 같은 함정 위에 있다) |
| **A30** | 트랙 B 화면은 워커의 **HTTP 진입점**으로 파이프라인을 부른다. 큐가 아니고, `apps/web` 이 `apps/worker` 를 직접 import 하지도 않는다 | `accepted` | ① **미리보기는 본질적으로 요청-응답이다.** 사용자는 표를 *보고 나서* 저장한다(보장선 B3). 큐로 하면 화면이 폴링·대기 상태를 다뤄야 하고, B 가 이미 만든 create-flow 를 그만큼 고쳐야 한다. ② **직접 import 는 경계를 무너뜨린다.** cheerio·playwright·Gemini SDK 가 Next 서버 번들로 끌려 들어가고, `apps/web → apps/worker` 의존이 생겨 트랙 경계가 디렉터리 경계와 어긋난다. ③ 워커에 HTTP 진입점이 생기면 **수동 수집 트리거(G3)** 도 같은 문 하나로 풀린다 — 지금은 밖에서 파이프라인을 부를 수단이 cron 등록뿐이다. 정기 수집은 지금처럼 큐로 남는다 (그건 요청-응답이 아니다) | ① 미리보기가 느려 브라우저 시한을 넘기면 → 그때 큐 + 폴링으로 바꾼다 (새 ADR). ② 워커를 여러 대로 늘리면 → 진입점 앞에 로드밸런서가 필요하고 호스트별 간격 제어(`http.ts` 의 프로세스 메모리 맵)를 Redis 로 옮겨야 한다 | `apps/worker` 의 HTTP 진입점(신설), `apps/web/lib/create.ts`(`buildMockPreview` 를 fetch 로 교체), `.env`(워커 주소·내부 토큰) |

## A31~ — 배포(G4)에서 생긴 결정

날짜는 2026-07-27 이다. (트랙 B 가 A27·A28 로 적었다가 main 의 번호와 겹쳐 A31·A32 로 옮겼다 —
커밋 메시지·과거 대화의 "A27/A28(배포)"는 이 두 줄을 가리킨다)

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A31** | HTTPS 는 Let's Encrypt 가 아니라 **Caddy 내부 CA(자체 서명)** | `superseded` (→ A32) | 캠프 VM(172.10.8.235)은 VPN 안 사설 IP 라 HTTP-01 챌린지가 불가능하고, 캠프 DNS API 가 언더스코어 레코드(`_acme-challenge`)를 금지해 DNS-01 도 불가능하다. HTTP 평문으로는 구글 OAuth 리디렉션 URI(https 필수)가 성립하지 않는다. 남는 선택지는 내부 CA 하나 — 첫 접속 시 브라우저 경고 1회를 감수한다 | 공인 IP VM 으로 옮기거나 DNS API 가 TXT `_acme-challenge` 를 허용하게 되면 → Caddyfile 의 `tls internal` 세 줄을 지우면 A9 원안(자동 LE)으로 복귀한다 | `deploy/Caddyfile`, deploy/README 의 G4 체크 "유효한 인증서(경고 없음)" 항목은 이 조건에서 "경고 후 진행"으로 완화 |
| **A32** | 외부 공개는 **Cloudflare Tunnel** — Caddy 는 8080 평문으로 터널을 받고, TLS 는 Cloudflare 엣지가 끝낸다 | `accepted` | A31 의 조건(사설 IP)이 그대로인 채로 "VPN 없는 방문자"가 필요해졌다. 캠프 DNS API 의 터널 기능이 `cloudflared` 아웃바운드 연결 + 정식 인증서를 제공한다 — 브라우저 경고가 사라지고 G4 "유효한 인증서" 체크가 원래 의미로 복원된다. Caddy 의 :443(내부 CA)은 VPN 직접 접속용으로 남긴다. 평문 블록은 `X-Forwarded-Proto: https` 를 명시한다 (엣지가 TLS 를 끝냈으므로 — 이게 없으면 Auth.js 콜백이 http 로 구른다) | 터널 API 가 사라지거나 순수 TCP/UDP 가 필요해지면 (터널은 HTTP 계열만 통과한다 — 7-8) | `deploy/Caddyfile` (`:8080` 블록 3개), `docker-compose.prod.yml` (caddy 에 127.0.0.1:8080 바인딩), VM 의 `cloudflared` systemd 서비스 |

## A33~ — 스펙 델타(07-27 논의)에서 확정된 결정

날짜는 전부 2026-07-27 이다. 근거·맥락 전문은 [spec-delta-0727.md](./spec-delta-0727.md) — 여기는 결정만 승격해 둔다.

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A33** | **뷰(View)를 일급 객체로** 도입하고, 컬렉션의 기본 표를 **조건 없는 뷰 #0** 으로 취급한다. 네 출구(표·알림·REST `?view=`·MCP)가 전부 `packages/core/src/query` 하나를 탄다 | `accepted` (07-27 저녁 계약 확정 — [view-contract-draft.md](./view-contract-draft.md) · 코드 반영 전) | 델타 2절. 뷰가 없으면 사용자가 소스 겹치는 컬렉션을 여러 개 만든다 — "컬렉션은 넓게, 뷰는 좁게". 기본 표를 특수 케이스로 두면 출구마다 쿼리가 갈라진다 | 컬렉션을 넘나드는 뷰 요구가 나오면 (채택 안 함 — 델타 16절) | `packages/core`(View 타입·query), `views`·`view_matches` 테이블, 작업실 탭, MCP 도구 생성 |
| **A34** | 알림은 상태가 아니라 **전이**다. v1 은 `enter` 하나만 — 뷰별 매칭 id 집합을 저장하고 run 마다 차집합. **매칭 집합은 현재 상태와 동기화한다**(나가면 삭제) — 즉 **재진입은 새 enter 로 다시 알린다** (07-27 저녁 확정: 마감 연기로 조건에 되돌아온 항목을 놓치지 않는다). **뷰 평가는 수집과 분리된 일일 잡**(KST 자정 직후)으로 돌고, 조건 값은 **상대 표현**(`this_month`·`d7`)으로 저장한다 | `accepted` (07-27 저녁 계약 확정) | 델타 2-5·2-6. `D-7 이내` 뷰는 데이터가 안 바뀌어도 전이가 일어난다(어제 D-8 → 오늘 D-7) — 그게 사용자가 가장 원하는 알림이다. 절대값 저장은 뷰를 한 달 뒤 죽인다 | `change`/`exit`/`gone` 이 필요해지면 → 항목 동일성 판정이 선행돼야 한다 (G3 이후 새 ADR) | `apps/worker` 뷰 평가 잡, `view_matches`, 스케줄러 |
| **A35** | **뷰 술어(op)는 zod 닫힌 집합.** 목록 밖 술어·자유 표현식·SQL 조각을 거부한다 — 변환 연산자(A2)와 같은 규율. date 조건의 절대 날짜는 **저장 계층에서만 거부**한다 (조회 계층 — REST 쿼리·표 필터 — 는 허용, 저장 시 상대 표현 변환을 제안) | `accepted` (07-27 저녁 계약 확정) | 델타 2-7. 뷰는 네 출구를 전부 타므로 한 번 열면 네 곳에서 안전성을 보장해야 하고 B2 점검에도 걸린다 | 술어로 표현 불가능한 조건이 반복되면 → 먼저 술어를 추가한다 (A2 와 동일) | `packages/core`(술어 스키마), 뷰 편집 UI |
| **A36** | 알림 **중복 제거는 사건당 채널 단위** — 같은 전이 사건에서 항목이 뷰 3개에 걸려도 채널당 1회 보내고 "3개 뷰에 걸림"을 표시한다. **재진입은 새 사건이라 다시 알린다** (A34 와 짝). 같은 (채널, 항목) 은 **24시간 안에 재발송하지 않는다** — 경계에서 흔들리는 값의 스팸 안전판. 메일은 하루 1회 묶음, 웹훅은 건별. `channel_key` 는 채널 id 가 아니라 kind+정규화 target 의 해시 (같은 URL 이 두 행이어도 1회) | `accepted` (07-27 저녁 — 재진입 결정으로 "평생 1회"에서 "사건당 1회"로 정정) | 델타 2-9. 뷰 단위 발송이면 스팸이 되고, 이 결정은 나중에 뒤집기 번거로워 지금 확정한다 | 없음에 가깝다 — 채널별 즉시/묶음 옵션이 생겨도 dedupe 단위는 유지 | `notification_log` 테이블 (구 notification_dedupe — 계약 §3), `apps/worker` deliver |
| **A37** | **추천·제안 기능을 만들지 않는다.** 능동성의 형태는 "정의는 사용자가, 관찰은 시스템이" — 침묵 감지·상태 줄처럼 관찰만 말한다 | `superseded` (→ A42) | 델타 4-4. 매 호출 LLM 개입은 결정성을 깨고(A1 위반), 시스템이 카테고리를 대신 정하면 정의권(강점 #1)을 침범한다 | 없음 — 제품 원칙이다 | 화면 전반, 소스 침묵 감지, 상단 상태 줄 |
| **A38** | **Run 이력과 항목 스냅샷을 삭제하지 않는다.** 시간축 기능(주기성·이상 감지)은 지금 안 만들되 스위치를 공짜로 유지한다 | `accepted` | 델타 10절. 보존 비용은 지금 0에 가깝고, 삭제하면 몇 달치 데이터를 되살릴 수 없다 | 저장 용량이 실제 문제가 되면 → 보존 기간 정책을 새 ADR 로 | `runs`·`items` 보존, O4(보존 기간) 재확정 |
| **A39** | 스키마 진화는 **기본은 버리되 언제든 승격** — 새 소스에만 있는 필드는 `_raw` 에 두고, 능동 알림으로 승격을 제안하며, 승격 버튼은 작업실 > 스키마 편집에 둔다 | `proposed` | 델타 6절. 자동 추가는 기존 소스 전부 null 컬럼을 만들고, 매번 묻기는 온보딩을 막는다 | 승격 요청이 소스 추가마다 반복되면 → 기본값 재검토 | `apps/worker` attach, 작업실 스키마 편집(G2 이후) |

## A40~ — Day 4(07-28)에서 생긴 결정

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A42** | **사용자가 명시적으로 요청할 때에 한해 소스 후보를 제안한다** (A37 의 전면 금지를 완화). 07-28 두 트랙 합의. 세 개의 선을 지킨다: ① **사용자가 자연어로 요청했을 때만** 부른다 — 자동·주기적 제안은 없다(상태 줄·침묵 감지는 관찰만, A37 정신 유지). ② **자동 추가하지 않는다** — 시스템은 후보 URL 을 제시할 뿐, 실제 붙이기는 사용자가 골라 붙여넣는다(정의권은 사용자). ③ **LLM 은 컴파일 경로에만**(A1) — 컬렉션 생성 시 사용자 클릭으로 1회 호출, 정기 수집·API·MCP 에는 절대 안 들어간다. 제안된 URL 은 검증 안 된 후보이므로 화면이 "확인해 보세요"로 표시하고, 실제 붙일 때 probe+guard 를 정상적으로 탄다 | `accepted` (07-28 — 코드 반영 중) | 델타 4-4 의 "정의권 침범"은 **시스템이 대신 정할 때** 성립한다. 사용자가 "경기도 창업 지원사업" 이라고 먼저 물었고 후보를 골라 붙이는 것은 정의권이 사용자에게 남는다. G4 낯선 사람 온보딩에서 "URL 을 어디서 찾지"가 실제 벽이었다 | 제안이 자동·주기적으로 새거나(A1·A37 정신 위반), 시스템이 골라 자동으로 붙이기 시작하면 → 즉시 되돌린다 | `apps/worker`(자연어→후보 URL 컴파일 함수·budget), `apps/web` 컬렉션 생성 흐름, 예산(budget.ts) |
| **A41** | **DNS 리바인딩을 접속 시점 이름 풀기로 막는다** — undici 를 worker 의존에 넣고 `Agent({connect:{lookup}})` 에 관문(`guardedLookup`)을 끼운다. fetch 계열 경로(html·json 수집 · 웹훅 발송)는 이 dispatcher 를 **명시로** 붙인다. A27 의 검사(`checkOutboundUrl`)는 그대로 앞단에 남는다 — 두 겹이다 | `accepted` | A27 이 "다시 보게 만드는 조건 ①"로 예약해 둔 그 작업이다. A27 의 검사는 이름을 풀어 보지만, 그 뒤 `fetch` 가 이름을 **다시** 풀어 TTL 0 리바인딩이면 검사한 IP 와 접속 IP 가 갈린다(TOCTOU). `net.connect` 는 lookup 이 돌려준 주소로 곧장 붙으므로 lookup 안에서 사설을 거르면 재조회 틈이 사라진다. 전역(`setGlobalDispatcher`) 대신 호출부 명시로 둔 이유: Gemini SDK 등 다른 fetch 를 건드리지 않게. 재현: `guardedLookup('localhost')` → `ENOTFOUND`(빈 배열) · 공인 IP 는 통과 | ① **browser 모드(Playwright)는 아직 이 방어 밖**이다 — undici 를 안 타므로 라우트 훅의 글자 판정(`checkOutboundUrlSync`)만 있다. Playwright 자체 이름 풀기를 고정하는 길이 필요해지면 새 ADR. ② 관문을 web·mcp 도 쓰게 되면 → `guardedLookup` 을 core 로 올린다(지금 `isPrivateHost` 만 core) | `apps/worker/src/fetchers/guarded-dispatcher.ts`(신설), `fetchers/http.ts`·`jobs/channels/webhook.ts`(dispatcher 명시), `apps/worker/package.json`(undici 의존) |
| **A40** | **읽기 전용 초대 링크를 v1 범위로 편입한다** (07-28 두 트랙 합의 — 델타 §9 의 "뷰어" 조각만). 결정 셋: ① 접근은 **구글 로그인 필수** — `collection_members`(role=`viewer`) 를 **덧붙인다**. 소유권 구조 개편(O11)이 아니다 — `owner_id` 는 그대로 두고 멤버십 테이블만 추가한다. ② 출구는 화면·REST·MCP 셋 — **화면은 멤버십 게이트**, REST·MCP 는 **기존 `api_key` 재사용**: 뷰어의 화면에 연결 문자열을 노출하는 것으로 세 출구가 열린다 (새 자격증명 체계를 만들지 않는다). ③ **폐기 포함** — 초대 링크 재생성 시 옛 링크는 `revoked_at` 기록으로 무효화(행 삭제 없음 — A38 과 같은 규율), 뷰어 제거의 실효는 api_key 회전이 담보한다. 부수: 이 작업이 화면 읽기 경로에 접근 검사가 없던 기존 구멍(slug 만 알면 private 컬렉션 화면이 열림)을 같이 막는다 | `accepted` | 07-28 사용자·B 합의로 gates 의 "G4 이후" 판정을 뒤집었다. 읽기 전용으로 한정하면 델타 §9 의 3단계 역할·토큰 마스킹이 전부 불필요해져 5일 안에 들어간다. 편집자·관리자 역할, 개인/팀 채널 분리는 **그대로 G4 이후다** | 편집 권한 공유가 필요해지면 → 델타 §9 전체 설계(3단계 역할)로, O11 선행 | `packages/core` db/schema + 마이그레이션 0002 (**G0 계약 변경 — B 통보**), `apps/web` 화면 게이트·`/invite/{token}`·링크 관리 UI, `docs/gates.md` G4 |

## A43~ — 단독 개발 전환(2026-11) 이후의 결정

날짜는 전부 2026-11-11 이다.

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A45** | **컴파일 직후, 수집 전에 필드 경로를 probe 표본에 대 본다** (JSONPath 모드 — `json`·`inline_json`). probe 가 이미 들고 있는 표본 행(`candidate.rows`, 객체)에 각 필드 경로를 적용해, **항목을 알아볼 칸**(`title` 칸이 있으면 title, 없으면 `link` 타입 칸 전부)이 표본 어디에서도 값을 내지 못하면 그 스펙을 거절하고 **행에 실제로 있는 키 목록**을 붙여 재생성한다. 규칙은 셋이다: ① 재생성 기회가 남았을 때만 거절한다 — 마지막 시도의 스펙은 그대로 넘겨 기존 흐름(수집 → 0건이면 재컴파일, create-collection ③-a)이 받게 둔다. LLM 호출 상한을 늘리지 않는다. ② 선택 칸(기관·마감 등)이 비는 것만으로는 거절하지 않는다 — 그건 이미 `repair-empty` 가 수집 후 걷어낸다. ③ 0건 재컴파일 안내문도 모드를 따른다 — JSONPath 모드면 "HTML 표본" 이 아니라 "JSON 표본" 이라 말하고 키 목록을 준다 | `accepted` (2026-11-11) | A43 실측(링커리어 `create-collection` 7회)에서 5회가 0건이었다. 모드·script·list 는 매번 맞았고, 실패한 판은 전부 행에 없는 키를 지어냈다 (`$.title`·`$.id` — 실제 키는 `url`·`name`·`imageUrl`). 신원 칸이 전부 비어 20행이 "신원 없는 행"으로 버려졌다. 재시도 안내문이 "HTML 표본에 있는 것으로 다시 골라라" 라고 말해 JSON 후보에는 엉뚱한 지시였고, 실제로 재시도도 같은 방식으로 실패했다. 표본 행은 probe 가 이미 받아 둔 것이라 **네트워크 없이** 확인할 수 있고, 결정론적 탐색이라 A1(LLM 은 컴파일 때만)·A2 와 충돌하지 않는다. 기존 json 모드(k-startup 07-30 "5열 생성 → 0건")에도 같은 실패가 기록돼 있어 inline_json 전용으로 두지 않는다 | ① CSS 모드(html·browser)에서도 같은 지어내기가 반복되면 → `row_html` 에 같은 검사를 적용한다 (지금은 관찰된 적이 없어 범위 밖). ② 표본이 작아 진짜 칸이 우연히 전부 비는 사이트가 나와 정상 스펙이 거절되면 → 기준을 "전부 비면" 에서 더 좁히지 말고 표본을 늘린다 | `apps/worker/src/compile/sample-check.ts`(신설), `compile/discover.ts`·`compile/compile-spec.ts`(재생성 루프), `pipeline/create-collection.ts`(③-a 안내문) |
| **A44** | **2인 팀 조정 규칙을 폐기한다.** `CLAUDE.md` 의 "트랙 경계" 절(A=worker · B=web·mcp · core=상호 통보)과 **G0 고정 계약**(core 타입 정의·DB 스키마·`GET /api/v1/{slug}` 응답 형태·시드 데이터·상태 값 집합을 "양쪽이 같이 있을 때만 바꾼다")을 더 이상 적용하지 않는다. 단독 개발이라 통보할 상대가 없고, 계약을 얼려 둘 이유도 같이 사라졌다. **폐기 범위는 조정 규칙뿐이다** — "하지 말 것" 절의 제약(B1~B7 · A1 LLM 런타임 금지 · A2 코드 실행 금지 · 닫힌 연산자·술어 집합 · Run 이력 삭제 금지)과 **ADR 이 코드보다 먼저**라는 절차는 그대로 유효하다. 이 결정은 ADR 에만 적지 않고 **같은 작업에서 `CLAUDE.md` 를 고친다**. `docs/gates.md` 의 G0 판정 기록과 기획서 14장은 **과거 사실이라 고치지 않는다**(A38 과 같은 규율 — 지우면 왜 그랬는지가 사라진다). 어긋나면 이 ADR 이 이긴다 | `accepted` | 트랙 경계는 "두 사람이 같은 파일을 만지지 않게" 하는 장치였다(기획서 14장). 사람이 하나면 이득은 0 이고 비용만 남는다. 특히 G0 고정 계약은 **core 타입 변경을 사실상 금지**하는데 A43 이 바로 그것을 요구한다 — 문서를 같이 고치지 않으면 다음 세션이 `CLAUDE.md` 에서 "core 타입은 양쪽이 같이 있을 때만 바꾼다" 를 읽고 A43 과 모순되는 지시를 따른다. 지시가 두 군데서 갈리는 것은 B2 를 테스트로 강제한 이유(A26)와 같은 종류의 위험이다 — 사람 눈으로만 지키는 규약은 급할 때 조용히 깨진다 | 공동 작업자가 생기면 → 트랙 경계를 **되살리지 말고** 그 시점의 디렉터리 구조에 맞는 조정 규칙을 새로 적는다(지금 구조는 G0 때와 이미 다르다). 계약을 다시 얼려야 하는 다른 이유가 생기면 — 외부 소비자가 `GET /api/v1/{slug}` 응답 형태에 의존하기 시작하면 → **그 계약만** 고정한다(O6·O10 과 함께 판단) | `CLAUDE.md`("트랙 경계" 절 · 코드 규약의 "남의 트랙" 문구 · 기획서 수정 절차의 "상대 트랙" 문구). `docs/gates.md`·`docs/기획서-v2.md` 14장은 기록으로 남긴다 |
| **A43** | fetch 모드에 **`inline_json`** 을 추가한다 — HTML 을 받아 페이지 안 `<script>` 의 JSON 을 꺼내고, **모든 경로를 JSONPath 로** 평가한다. 네 가지를 같이 확정한다.<br><br>**① 스크립트 지목은 닫힌 유니온(`ScriptLocator`) 이다.** 네 갈래뿐이다 — `id`(`<script id="__NEXT_DATA__">` 류. `format: 'devalue'` 로 Nuxt 3 의 `__NUXT_DATA__` 포함) · `global`(`window.__INITIAL_STATE__ = {…};` 대입) · `ld_json`(**`@type` 이 `ItemList` 인 ld+json 을 찾아서** 쓴다 — 순번으로 가리키지 않는다) · `json_script`(이름 없는 `application/json`, **순번**).<br><br>**② 벗기는 파서는 `JSON.parse` 하나다.** 벗기기 규칙을 스펙에 적지 않는다. `global` 의 추출은 코드에 고정된 알고리즘 하나다: 이름 → 첫 `=` → 괄호 짝이 맞는 조각 하나 → `JSON.parse`. 그래서 `__NUXT__=(function(a,b){…})(…)` 같은 IIFE·JSONP·문자열 연결은 **지원하지 않고 포기한다** — 그 사이트는 네트워크 관찰(probe 3단계)·browser 가 받는다. 벗기기 규칙을 스펙에서 조립할 수 있게 열면 그것이 곧 표현식 평가의 앞문이고 A2("샌드박스 비용 0")가 무너진다.<br><br>**③ "모드 → 경로 문법" 을 단일 출처(`pathSyntaxFor`)로 둔다.** `json`·`inline_json` → JSONPath, `html`·`browser` → CSS. 지금 모드와 문법의 관계가 일곱 곳에 `mode === 'json'` 불리언으로 박혀 있어, 모드가 넷이 되는 순간 조용히 틀린다. 다만 **일괄 치환하지 않는다** — `mode === 'json'` 분기는 두 종류가 섞여 있다. *경로 문법 판정*(`paths.ts`·`spec.ts`·`interpret.ts:78`·`trace-value.ts`·`fetchers/index.ts` 의 `nextUrl`)만 `pathSyntaxFor` 로 바꾸고, *받아온 본문이 이미 JSON 인가* 판정은 그대로 둔다 — `infer-pagination.ts:65` 는 HTML 본문에서 페이저 링크를 긁는 함수라 `json` 만 건너뛰는 것이 맞고, `inline_json` 은 본문이 HTML 이므로 **그대로 혜택을 받아야 한다**(문법 기준으로 바꾸면 페이지네이션 추론이 사라진다). 반대로 `attach-source.ts:384` 의 `rowsForTrace` 는 꺼낸 것이 객체이므로 `inline_json` 을 json 쪽에 **포함**시킨다.<br><br>**④ 스크립트 목록은 재구현하지 않고 `HtmlAdapter` 로 주입받는다** (A18 의 방식 그대로). core 에 문자열 스캐너를 새로 쓰지 않고 `HtmlAdapter.scripts(html)` 를 더해 cheerio 의 검증된 파싱을 쓴다. 스캐너가 하나로 유지되므로 probe 가 매긴 순번과 수집 시점의 순번이 어긋나는 사고가 **설계상** 생길 수 없다.<br><br>페이지네이션은 `page_param`·`none` 그대로, `next_link` 는 꺼낸 JSON 기준 **JSONPath**(한 모드 한 문법 — 여기서 CSS 를 섞으면 ③의 매핑이 부분함수가 된다), `scroll` 은 기존 browser 전용 검사가 그대로 거부한다 | `accepted` (2026-11-11 코드 반영 — 실측: 링커리어 20건 `id` · 온오프믹스 19건 `ld_json`. LLM 컴파일 경로는 키가 없어 테스트로만 검증) | probe 1단계(인라인 JSON)가 이미 후보를 찾아내는데(A3 의 가장 싼 경로) 스펙에 표현할 자리가 없어 후보가 `fetch_mode: 'html'` 로 강등되고, 컴파일 LLM 이 CSS 선택자로 script 태그 **안을** 집으려다 추출이 0건이 된다 (`probe/inline-json.ts` 43행 주석·파일 끝 메모 — "G1 에서 결정한다"고 미뤄둔 그 결정이다). 런타임에 LLM 도 코드 실행도 늘지 않고 순수 탐색만 추가되므로 A1·A2 와 충돌하지 않는다. `FETCH_MODES`(구 G0 계약 #5)가 넓어지지만 DB 는 `text` 컬럼(A19)이라 마이그레이션이 없다 | **벗기기 규칙을 늘리고 싶어지는 것은 이 결정을 다시 보게 만드는 조건이 아니다.** JSON.parse 로 안 풀리는 대입문(IIFE·JSONP·문자열 연결)이 반복해서 나오는 것은 예상된 일이고, 그때 할 일은 규칙 추가가 아니라 그 사이트를 네트워크 관찰·browser 로 보내는 것이다. 다시 보는 것은 **인라인 JSON 외의 경로가 전부 막히는 사이트군이 주류가 될 때**이며, 그때도 선택지는 코드 평가가 아니라 browser 경로 강화다.<br><br>그 밖에 다시 보게 만드는 것 둘:<br>① **`json_script` 의 순번 취약성** — 사이트가 `application/json` 스크립트 하나만 더해도 순번이 밀려 다른 데이터를 읽거나 추출이 0건이 된다. 지금은 자가 치유(재컴파일)가 이것을 받아내는 것을 전제로 둔다. 같은 밀림이 실측에서 반복되면 → 순번 대신 **내용 지문**(반복 키 집합의 해시)으로 가리킨다. `ld_json` 은 그 취약성을 피해 처음부터 `ItemList` 매칭으로 둔 것이다.<br>② **`HtmlAdapter` 가 늘어난 것** — 지금 구현체는 `cheerioAdapter` 하나다(`apps/web`·`apps/mcp` 는 `@endpointer/core/spec` 을 import 하지 않는다 — A30 대로 미리보기도 워커를 탄다). A30 이 뒤집혀 해석기를 브라우저에서 돌리게 되면 DOMParser 구현이 필요하고, 거기서 `scripts()` 도 같이 구현해야 한다 | `packages/core/src/types/source.ts`(FETCH_MODES), `spec/spec.ts`(`InlineJsonFetchSpec`·`ScriptLocator`·`pathSyntaxFor`), `spec/paths.ts`(`HtmlAdapter.scripts`·`checkPathSyntax`), `spec/inline-script.ts`(신설 — probe 의 추출 함수 이관), `spec/interpret.ts`·`json-schema.ts`·`validate.ts`, `apps/worker`: `fetchers/index.ts`(`fetchPage`·`nextUrl`)·`fetchers/cheerio-adapter.ts`·`html.ts`·`probe/inline-json.ts`·`probe/types.ts`·`compile/prompts/*`(`compile-spec`·`discover`·`match-fields`·`shared`)·`compile/compile-spec.ts`·`discover.ts`·`repair-draft.ts`·`trace-value.ts`·`pipeline/attach-source.ts`·`repair-field.ts`·`infer-pagination.ts`, `apps/web/lib/collections.ts`(`MODES`) |


## A46~ — 조회·뷰·키·공유 정비 (2026-11-11)

날짜는 전부 2026-11-11 이다. 다섯 결정이 한 묶음이다 — 표·REST·MCP 가 **같은 조회 경로**를 타게 만들고(A46·A47),
그 경로의 문을 정비하고(A48·A49), 그것을 기계로 증명한다(A50).

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A46** | **조회는 엄격하다 — 적용할 수 없는 조건은 거절하고, 표·REST·MCP 가 같은 해석·실행 경로를 탄다.** ① `parseCollectionQuery` 의 "버리고 경고" 를 **거절**로 바꾼다: 모르는 조건·스키마 밖 칸·값 형식 오류·범위 조건을 못 쓰는 칸·중복 파라미터·모르는 `include`·`limit` 상한 초과·못 읽는 커서는 전부 문제(problem)로 모아 실패를 돌려준다. 빈 값(`?category=`)만 "조건 없음" 으로 본다(폼 관례 — 문서화). ② 문제 코드는 하나의 집합이다: `invalid_query`(400) · `limit_exceeded`(400) · `invalid_cursor`(400) · `view_not_found`(404) · `view_unavailable`(422) · `unauthorized`(401) · `not_found`(404) · `unavailable`(503). REST 는 상태 코드 + `error{code,message,problems}`, MCP 는 `isError` 도구 결과 + 같은 `code`·문장. **같은 입력이면 성공·실패와 원인이 같다** — 둘 다 core 의 `resolveCollectionRequest` 하나를 부르기 때문이다(MCP 도구 입력 스키마의 상한 검사를 빼고 core 에 맡긴다). ③ **뷰 위의 조건은 AND 로만 얹는다** — 뷰 계약 §4 의 "쿼리 파라미터가 뷰를 덮어쓴다" 를 대체한다. 범위는 좁은 쪽, 하나뿐인 조건(`q`·`source`·같은 칸 완전일치)이 뷰와 다르면 `invalid_query`. 정렬·개수·커서만 요청이 정한다. 없는 뷰는 404, 쓸 수 없게 된 뷰는 422 — **뷰를 빼고 더 넓은 결과를 내지 않는다.** ④ 커서 v2: `(정렬값, id)` 에 **조건·정렬 지문**과 앞선 행 수를 싣는다. 지문이 지금 요청과 다르면 `invalid_cursor` — 조건이 바뀌었는데 옛 커서로 이어 붙이는 일을 서버가 막는다. 시각 정렬은 **밀리초로 자른 값**으로 정렬·비교한다(같은 트랜잭션에서 들어온 항목은 `now()` 의 마이크로초까지 같아 ms 커서로는 경계에서 행이 샌다). 커서에 싣는 정렬값은 SQL 식과 같은 규칙으로 뽑는다(숫자 칸의 숫자 아닌 값 → null, 불리언 → 문자열). v1 커서는 받지 않는다. ⑤ 웹 표도 이 경로를 탄다 — 검색·출처·정렬·페이지가 전부 서버 조회이고 상태는 URL 에 있다. 브라우저에서 200개를 받아 거르는 방식을 없앤다 | `accepted` | 표는 200개만 받아 브라우저에서 검색·정렬했다 — 201번째 이후는 검색에도 정렬에도 안 잡히는데 화면은 그걸 말하지 않았다. REST 는 모르는 조건을 버리고 **더 넓은 결과**를 200 으로 냈다(경고는 본문 한 칸) — 오타 하나로 "마감 임박만" 이 "전부" 가 되어도 클라이언트는 성공으로 읽는다. REST 는 없는 뷰를 무시하고 전체를 냈고, MCP 뷰 도구는 같은 상황을 오류로 냈다 — 같은 입력에 판단이 갈렸다. 커서는 조건을 몰라 정렬을 바꾼 요청에도 이어 붙었다. 원칙 ④(부분 성공)는 **출처 단위**의 이야기이지 "요청한 조건을 일부만 적용" 의 근거가 아니다 | 거절이 실제 사용자를 반복해서 막는 조건이 생기면(예: 새 파라미터를 모르는 구 클라이언트) → 그 파라미터만 명시적 허용 목록에 올린다. 관대함을 기본값으로 되돌리지 않는다 | `packages/core/src/query/*`(params·build·respond·resolve 신설), `types/api.ts`, `apps/web/app/api/v1/[collection]/route.ts`, `apps/web/app/collections/[slug]/table/page.tsx`·`components/collection-table.tsx`, `apps/mcp/src/tools.ts`, `docs/api.md`(신설), 뷰 계약 §4(이 행이 대체) |
| **A47** | **뷰는 "조회 상태" 와 "표시 설정" 두 층으로 저장한다.** 조회 상태 = 칸 조건(`where`) · 정렬 첫 항목 · 검색어(`q`) · 출처(`source`) — 웹·REST·MCP 가 같은 뜻으로 적용한다. 표시 설정 = 열 표시와 순서(`columns`, 출처 열 `_source` 포함) — 웹에서만 복원한다. 새 컬럼 `views.search_q`·`views.source_host` 를 더하고(기존 행은 null = 조건 없음 → 그대로 호환), 표시 설정은 기존 `columns_json` 을 쓴다. **건강 판정은 조회 상태만 본다** — 열이 사라진 것은 표시에서 걸러내고 뷰를 깨뜨리지 않는다. 조회 상태가 스키마·출처와 안 맞으면(칸 삭제·타입 변경·출처 제거) 뷰는 `broken` 이고, 화면은 **무엇이 왜 안 맞는지**와 "표에서 고쳐 다시 저장" 경로를 보인다. 수정은 slug 를 유지한다(REST `?view=`·MCP 도구 이름이 그대로). 상대 날짜는 저장 그대로(A34), 해석은 조회 시각 `now` 로. 생성·수정·삭제는 주인만 — 서버 함수가 행위자를 받아 판정한다(화면 숨김과 별개) | `accepted` | 뷰는 칸 조건만 담을 수 있었다 — 표에서 검색어·출처·정렬을 걸고 "저장" 하면 그 셋이 조용히 빠졌다(저장된 뷰가 본 것보다 넓다). 열 설정은 localStorage 에만 있어 뷰에 못 실렸다. 그리고 `columns` 의 사라진 칸이 뷰 전체를 `broken` 으로 만들어 REST·MCP 까지 멈추게 하는 구조였다 — 표시 문제로 조회가 죽으면 안 된다 | 뷰가 여러 정렬 키를 실제로 필요로 하면(CollectionQuery 가 정렬 하나라 지금은 첫 항목만 쓴다) → 커서 v3 와 함께 | `packages/core/src/types/view.ts`·`query/view.ts`, `db/schema.ts` + 마이그레이션, `apps/web/lib/views.ts`·`view-actions.ts`·표 화면, `apps/mcp/src/views.ts` |
| **A48** | **API 키는 서버가 만들고, 원문은 발급 응답에서 한 번만 보이며, 저장은 해시뿐이다.** 키 = `ep_` + 32바이트 난수(base64url, 256비트). 저장 = SHA-256 hex(`api_key_hash` — 고엔트로피 난수라 느린 해시가 필요 없다, 기존 판단 유지) + 식별용 앞 글자(`api_key_hint`, 원문 앞 7자) + 발급 시각. 발급·교체는 같은 연산(새 해시로 덮어쓰기 → 옛 키는 즉시 무효), 폐기는 해시를 지운다. 주인만 한다. 키 판정(`hashApiKey`·`apiKeyMatches`·`decideApiAccess`)은 **core 의 `@endpointer/core/auth`** 로 올려 REST 와 MCP 가 같은 함수를 쓴다(node 전용 진입점 — 루트 배럴은 브라우저 안전성을 유지한다, A18). 원문 키는 URL·로그·분석 이벤트에 남기지 않는다: 웹은 키가 든 주소를 더 이상 만들지 않고, 인증은 `Authorization: Bearer` 가 기본이다. **MCP `?key=` 는 유지하되 폐기 예정**이다 — 이미 연결된 커넥터가 끊기지 않게 서버는 계속 받지만 화면은 안내하지 않으며, 키를 교체하면 그 주소도 함께 무효가 된다 | `accepted` | 비공개 컬렉션의 키를 만드는 화면·코드가 없었다 — `api_key_hash` 는 늘 null 이라 비공개 컬렉션은 REST·MCP 로 **아무도** 열 수 없었다. 판정 코드는 web(`public-api.ts`)과 mcp(`auth.ts`)에 두 벌이었다(mcp 쪽 TODO 가 그 사실의 기록). `?key=` 는 키를 질의 문자열에 실어 프록시·접근 로그·브라우저 기록에 남긴다 | ① 커넥터 OAuth(MCP Authorization)를 붙이면 → `?key=` 를 **제거**하는 새 ADR. ② 키를 여러 개(용도별) 둬야 하면 → 키 테이블로 분리. ③ 보장선 B7(주소 한 줄)은 비공개 컬렉션에서 헤더를 받는 커넥터로 좁아진다 — 한 줄 경로는 `unlisted` 다. 이게 실제 온보딩을 막으면 OAuth 를 앞당긴다 | `packages/core/src/auth/*`(신설), `db/schema.ts`(+`api_key_hint`·`api_key_created_at`), `apps/web/lib/api-keys.ts`·연결·설정 화면, `apps/web/lib/public-api.ts`, `apps/mcp/src/auth.ts`·`connect-string.ts` |
| **A49** | **공개 범위·공유 설정의 뜻을 실제 권한과 일치시킨다.** 접근 경로는 넷이고 서로 독립이다: ① **웹 작업 화면** — 주인과 멤버만(공개 범위와 무관, A40). ② **초대 링크** — 멤버가 되는 문. 끄거나 다시 만들어도 이미 들어온 멤버는 남는다. ③ **공개 범위(REST·MCP)** — `private` 은 키 필요, `unlisted` 는 주소가 곧 열쇠, `public` 은 누구나 + 모두의 컬렉션 상세 화면에서 읽기. ④ **API 키** — `private` 의 REST·MCP 열쇠. 멤버를 내보내도 그 사람이 가진 키·`unlisted` 주소로의 접근은 막히지 않는다 — 막으려면 키 교체 또는 공개 범위 변경이다(화면이 이걸 말한다). 정렬하는 동작 둘: **복제는 `public` 만**(워커가 `unlisted` 도 복제해 줘 REST 로는 안 보이는 출처 주소·추출 규칙까지 넘어갔다), **`public` 에서 벗어나면 전시(`listed`)를 내린다**(남겨 두면 다시 공개하는 순간 예고 없이 갤러리에 재등장했다). 설정 변경 요청은 서버가 주인 여부와 컬렉션 소속(그 키·멤버·뷰가 이 컬렉션의 것인가)을 확인한다 | `accepted` | 설정 화면은 공개 범위를 이름 셋으로만 보여줬고("주소를 아는 사람"), 초대 링크·멤버·키가 각각 무엇을 막고 무엇을 안 막는지 말하지 않았다. 그 사이 실제 동작 두 곳이 화면의 말과 어긋나 있었다(복제·전시) | 편집자 역할(델타 §9)이 생기면 → ①의 판정이 넓어진다. 이 표를 같이 고친다 | `apps/web/app/collections/[slug]/settings`·`actions.ts`·`share-actions.ts`, `apps/web/lib/collections.ts`, `apps/worker/src/pipeline/clone.ts`, 연결 화면 |
| **A50** | **검증은 다시 돌릴 수 있어야 하고, 못 돌린 것은 성공으로 적지 않는다.** DB 가 필요한 테스트는 **전용 데이터베이스 `endpointer_test`** 에서만 돈다(같은 Postgres 서버에 없으면 만들고 마이그레이션을 적용 — 개발 DB `endpointer` 는 절대 건드리지 않는다. 이름이 같으면 거부한다). DB 에 닿지 못하면 그 테스트는 **건너뜀으로 표시**되고 이유를 출력한다 — 통과로 세지 않는다. 외부 사이트·실제 LLM 에 의존하지 않는다: 수집은 테스트가 띄운 로컬 HTTP 서버, 웹훅은 로컬 수신 서버, 큐(Redis)는 같은 함수를 직접 부르는 것으로 대체한다 — 대체한 경계는 테스트 머리말에 적는다. REST 는 라우트 핸들러를 직접 부르고(Next 서버는 띄우지 않는다), MCP 는 실제 HTTP 서버를 임의 포트로 띄워 공식 SDK 클라이언트로 부른다(그러려고 앱 생성과 listen 을 분리한다). 기준 시각은 고정한다 | `accepted` | 여섯 영역 모두 "테스트 파일만 추가" 로는 증명이 안 된다 — 커서 경계·권한·키 폐기는 실제 SQL 과 실제 HTTP 에서만 드러난다(예: 마이크로초 커서 누락은 순수 함수 테스트로는 안 보였다). 개발 DB 에는 사용자의 실데이터가 있다 | CI 가 생겨 DB 를 매번 띄울 수 있게 되면 → 건너뜀을 실패로 바꾸는 플래그(`REQUIRE_DB_TESTS=1`)를 CI 에서 켠다 | `packages/core/src/testing/*`(신설, `@endpointer/core/testing`), `*.db.test.ts`, `apps/mcp/src/app.ts`(신설), `docs/api.md` |


## A51~ — 검증 도구 (2026-11-16)

| # | 결정 | 상태 | 근거 | 이걸 다시 보게 만드는 조건 | 영향받는 곳 |
|---|---|---|---|---|---|
| **A51** | **web 의 lint 와 브라우저 시험을 실제로 돌게 한다.** ① lint: `apps/web/eslint.config.mjs`(flat config — Next 공식 `core-web-vitals` + `typescript` 규칙)를 두고, **web 의 `eslint` 를 10 → 9 로 내린다.** ② 브라우저 시험: web 의 개발 의존성에 `playwright` 를 **워커와 같은 버전**으로 넣어 이미 설치된 Chromium 을 같이 쓴다. 별도 러너(`@playwright/test`)는 들이지 않고 기존 vitest 가 라이브러리를 부른다. 시험은 `*.e2e.ts` 로 두어 `pnpm test` 에 섞이지 않게 하고 `pnpm --filter @endpointer/web test:e2e` 로 돈다 — 빌드한 앱을 **테스트 DB** 에 붙여 띄우고 실제 브라우저로 누른다. DB·브라우저가 없으면 건너뜀으로 표시한다(A50) | `accepted` (2026-11-16) | ① 설정 파일이 없어 ESLint 9+ 는 실행조차 안 됐다. 파일을 두자 이번엔 크래시했다 — `eslint-config-next` 가 묶어 오는 `eslint-plugin-react@7.37.5` 는 `eslint ^9.7` 까지만 지원하고 ESLint 10 에서 사라진 `context.getFilename()` 을 부른다. 호환층(`@eslint/compat`)을 새로 들이는 것보다 지원 범위 안으로 내리는 쪽이 의존이 적다. ② 열 끌기·열 고르기·저장 폼은 서버 함수 테스트로는 안 잡히는 클라이언트 동작이다(`router.replace`·드래그 이벤트). 워커가 이미 Playwright 와 Chromium 을 들고 있어 새로 내려받을 것이 없다 | ① `eslint-plugin-react` 가 ESLint 10 을 지원하면(또는 `eslint-config-next` 가 그 판을 묶으면) → 10 으로 되돌린다. ② 브라우저 시험이 늘어 vitest 로 다루기 버거워지면(병렬·재시도·추적) → `@playwright/test` 를 새 ADR 로 | `apps/web/package.json`(eslint ^9 · playwright · `test:e2e`), `apps/web/eslint.config.mjs`(신설), `apps/web/vitest.e2e.config.ts`·`e2e/*`(신설), lint 가 짚은 web 소스(`create-flow`·`tour`·`view-rename`·`page`·`hero-band`·`layout` — 고친 뒤 브라우저 시험으로 같은 동작 확인) |

---

## 열린 결정 (기획서 16장) — 정해지면 여기로 승격

| # | 열린 질문 | 정해야 하는 시점 | 기본값 | 현재 |
|---|---|---|---|---|
| O1 | 도메인 이름 | G4 이전 | 미정 (`endpointer` 는 가칭) | 미정 |
| O2 | 컬렉션 공개 범위 기본값 | G2 | `unlisted` | 시드는 `unlisted`, DB 기본값은 `private` |
| O3 | 수집 주기 기본값 | G3 | 하루 1회 | `sources.schedule` 기본값 `0 6 * * *` |
| O4 | 아이템 보존 기간 | G3 | 무제한 | 무제한 |
| O5 | `raw_json` 저장 범위 | G2 | 원본 객체 전체 | 전체 + 필드별 변환 전 원값(`_row`/`_fields`) |
| O6 | 스키마 v(n-1) 응답 유지 | G4 | 유지 안 함 | 미정 |
| O7 | 즐겨찾기 위치 | G3 | 컬렉션 안 `starred` 플래그 | 미정 — 델타 12절(항목별 개인 표시)과 합쳐 판단 |
| O8 | 소스 수집 공유 | 범위 밖 (v3) | 사용자별 독립 수집 | 범위 밖 |
| O9 | 대상 사용자 — 온보딩·발표에서 비개발자와 개발자 중 누굴 앞에 세우나 (델타 1-3) | **G3 저녁** | 비개발자 앞 (강점=정의권이면) · MCP 는 각주로 | 미정 |
| O10 | `schema_version` 의 의미 — 올라가면 API 소비자가 깨지는가, 웹훅 구독자에게 알리는가 (델타 6-3) | G3 | 경고만 (O6 연장) · 뷰 참조 필드 소실은 `broken` | 미정 |
| O11 | 소유자를 user 직접 참조 대신 한 단계 띄우기 + 멤버십(role) 테이블 (델타 9절·13-1) | 팀 기능 착수 전 (G4 이후) | 지금은 안 바꿈 — 초대 기능이 실제로 시작되면 | 미정 |
| O12 | Run 을 컬렉션이 아니라 소스 단위로 (델타 13-1 — 모두의 컬렉션 복제 대비) | 모두의 컬렉션 착수 전 | 현행 유지 | 미정 |
| O13 | 제품명 (`endpointer` 는 가칭 — 델타 1-3 재검토 대상) | G5 발표 전 | 미정 | 미정 |
