# 컬렉션 API · AI 연결(MCP) 사용 문서

> 기준: ADR A46~A49 (2026-11-11). 웹 표 · REST · MCP 는 **같은 조회 함수**(`@endpointer/core/query` 의
> `runCollectionRequest`)를 탄다 — 같은 데이터·조건·기준 시각이면 세 곳의 항목과 순서가 같고,
> 같은 입력이면 성공·실패 판단과 원인이 같다.

## 1. 기존 사용자에게 영향을 주는 변경 (2026-11)

| 바뀐 것 | 예전 | 지금 | 근거 |
|---|---|---|---|
| 적용할 수 없는 조건 | 버리고 `warnings` 를 붙여 **200** (결과가 더 넓어짐) | **거절** — 400/404/422 + `error.code`·`error.problems`. `warnings` 칸은 없어졌다 | A46 ① |
| `limit` 이 200 초과 | 200 으로 줄이고 경고 | **400 `limit_exceeded`** | A46 ① |
| 같은 파라미터가 두 번 | 첫 번째만 적용 | **400 `invalid_query`** | A46 ① |
| `?view=` 가 없는 뷰 | 조건 없이 전체 + 경고 | **404 `view_not_found`** | A46 ③ |
| `?view=` 가 깨진 뷰(칸 삭제 등) | 조건 없이 전체 + 경고 | **422 `view_unavailable`** + 원인 | A46 ③ |
| `?view=` 위의 파라미터 | 뷰를 **덮어씀**(넓힐 수 있었음) | 뷰 위에 **AND 로만** — 범위는 좁은 쪽, 다른 검색어·출처·같은 칸 값은 400 | A46 ③ (뷰 계약 §4 대체) |
| 커서 | v1 — 조건을 몰라 정렬을 바꿔도 이어 붙었음 | v2 — 조건·정렬 지문을 싣는다. 다르면 **400 `invalid_cursor`**. v1 커서는 받지 않는다 | A46 ④ |
| 기본 정렬 페이지 이동 | 같은 수집에서 들어온 항목(같은 마이크로초)이 페이지 경계에서 **빠졌다** | 밀리초 기준 정렬·비교로 고침 — 누락·중복 없음 (실측: 230개 중 44개만 나오던 것이 230개) | A46 ④ |
| 응답 `page` | `{ limit, next_cursor }` | `{ limit, next_cursor, total, offset }` (덧붙임 — 무시해도 된다) | A46 |
| 비공개 키 | 발급 화면 없음(비공개는 아무도 못 열었음) | 연결 화면에서 주인이 발급·교체·폐기 | A48 |
| MCP `?key=` | 화면이 키를 주소에 실어 줬음 | **폐기 예정** — 서버는 아직 받지만 화면은 더는 만들지 않는다. 헤더를 쓴다 | A48 |
| MCP 모르는 인자 | 조용히 버림 | REST 와 같은 `invalid_query` | A46 ② |

## 2. REST — `GET /api/v1/{slug}`

### 인증 (A48·A49)

| 공개범위 | REST · MCP | 키 |
|---|---|---|
| `private` (비공개) | 키가 있어야 열린다 | `Authorization: Bearer ep_…` (**헤더만**. REST 는 주소의 `?key=` 를 받지 않는다) |
| `unlisted` (주소를 아는 사람) | 키 없이 열린다 — 주소(slug)가 곧 열쇠 | 필요 없음 |
| `public` (전체공개) | 키 없이 누구나. 모두의 컬렉션 상세 화면에서도 읽힌다 | 필요 없음 |

- 키는 서버가 만든 256비트 난수(`ep_` + 43자). 서버에는 SHA-256 해시와 앞 7자만 남는다. 원문은 발급 응답에서 한 번만 보인다.
- 교체하면 옛 키는 그 순간 REST·MCP 모두에서 무효. 폐기하면 비공개 컬렉션은 다시 발급할 때까지 아무도 못 연다.
- 웹 작업 화면(표·뷰·설정)은 공개범위와 무관하게 **주인과 초대받은 멤버만** 들어온다.

### 파라미터

| 이름 | 뜻 | 예 |
|---|---|---|
| `{칸}` | 완전일치 (enum 은 원문 표기도 정규화) | `category=rnd` |
| `{칸}_gte` · `{칸}_lte` | 범위 — date·money·number 칸만 | `deadline_gte=2026-08-01` |
| `q` | 글자 칸 전체 검색 (최대 200자) | `q=청년` |
| `source` | 출처 호스트 | `source=k-startup.go.kr` |
| `since` | 처음 올라온 시각 이후 (`YYYY-MM-DD` 또는 ISO 시각) | `since=2026-07-20` |
| `sort` | 정렬. `-` 는 내림차순. 칸 키 또는 `first_seen_at`·`last_seen_at` | `sort=-amount` |
| `limit` | 1~200 (기본 50) | `limit=20` |
| `cursor` | 직전 응답의 `page.next_cursor` | |
| `include` | `provenance` — 값의 원문 위치 | |
| `view` | 저장된 뷰(조건) slug | `view=big-rnd` |

- **빈 값은 조건 없음**이다(`?category=`) — 폼이 비워 둔 칸을 그대로 보내는 관례. 그 밖의 못 읽는 값은 전부 거절된다.
- 정렬값이 같은 행은 항목 id 로 순서가 고정된다. 빈 값은 오름·내림 모두 맨 뒤.

### 페이지 이동

```
GET /api/v1/{slug}?sort=-amount&limit=50
→ { items: [...], page: { limit: 50, next_cursor: "…", total: 213, offset: 0 } }
GET /api/v1/{slug}?sort=-amount&limit=50&cursor=…   ← 조건·정렬은 그대로
→ { …, page: { …, offset: 50 } }
```

- 조건이나 정렬을 바꾸면 `cursor` 없이 처음부터 요청한다. 바꾼 채 옛 커서를 보내면 `400 invalid_cursor`.
- `limit` 만 바꾸는 것은 같은 요청이다 — 커서가 그대로 이어진다.
- `total` 은 조건에 맞는 전체 개수, `offset` 은 이 페이지 첫 항목의 위치(0부터).
- 상대 날짜가 든 뷰(`D-7 이내` 등)는 KST 자정에 범위가 바뀐다 — 자정을 넘긴 커서는 `invalid_cursor` 가 될 수 있다(결과 집합이 바뀌었기 때문).

### 오류

실패해도 응답 모양(`items`·`sources`·`schema_version`·`page`)은 같고 `error` 가 붙는다.

```json
{ "items": [], "sources": {}, "schema_version": 0, "page": { "limit": 0, "next_cursor": null, "total": 0, "offset": 0 },
  "error": { "code": "invalid_query", "message": "이 컬렉션에 없는 조건입니다: titel",
             "problems": [{ "code": "invalid_query", "message": "…", "param": "titel" }] } }
```

| code | HTTP | 언제 | MCP |
|---|---|---|---|
| `invalid_query` | 400 | 모르는 조건·칸, 값 형식, 범위를 못 쓰는 칸, 중복 파라미터, 뷰와 충돌하는 조건 | `isError: true` · 같은 code·message |
| `limit_exceeded` | 400 | `limit` > 200 | 〃 |
| `invalid_cursor` | 400 | 못 읽는 커서, 다른 조건·정렬의 커서 | 〃 |
| `view_not_found` | 404 | 없는 뷰 | (뷰 도구는 있는 뷰만 생긴다) |
| `view_unavailable` | 422 | 표 구성이 바뀌어 쓸 수 없게 된 뷰 — 원인 문장 포함 | 〃 |
| `unauthorized` | 401 | 비공개인데 키가 없거나 틀림(교체·폐기 포함) | 연결 단계 HTTP 401 |
| `not_found` | 404 | 없는 컬렉션 | 연결 단계 HTTP 404 |
| `unavailable` | 503 | 저장소 장애 | |

## 3. MCP — `{MCP 주소}/{slug}`

- 도구: `list_items`(REST 파라미터와 이름이 같다) · `search_items` · `get_schema` · `get_sources_status` · **저장된 뷰마다 도구 하나**.
- 모든 목록 도구는 `limit`·`cursor` 를 받는다. 뷰 도구도 `cursor` 로 이어 볼 수 있다.
- 결과의 `structuredContent` 는 REST 응답 본문과 같은 객체다. 실패는 `isError: true` + `structuredContent.error`(REST 와 같은 `code`·`message`·`problems`).
- 모르는 인자는 버리지 않는다 — REST 와 같은 `invalid_query` 로 실패한다.
- 비공개 컬렉션은 커넥터의 헤더 칸에 `Authorization: Bearer <API 키>`. 주소 칸 하나만 있는 커넥터는 공개범위를 `unlisted` 로 두면 주소만으로 연결된다.
- `?key=` 는 **폐기 예정 호환 경로**다. 이미 연결된 커넥터가 끊기지 않게 서버는 받지만 새로 안내하지 않는다. 키를 교체하면 그 주소도 함께 무효가 된다. 서버 로그에는 키 대신 "어느 경로로 왔는지" 만 남는다 — 그 수가 0 이 되면 제거한다(새 ADR).

## 4. 저장된 뷰 (A47)

| 층 | 무엇 | 어디서 적용 |
|---|---|---|
| 조회 상태 | 칸 조건 · 검색어(`q`) · 출처(`source`) · 정렬(첫 항목) | 웹 · REST `?view=` · MCP 뷰 도구 · 알림 — 같은 뜻 |
| 표시 설정 | 보일 열과 순서 | 웹에서만 복원. 사라진 열은 걸러질 뿐 뷰를 깨뜨리지 않는다 |

- 날짜 조건은 상대 표현(`이번 달`·`D-7 이내`)으로 저장되고 **조회 시각**에 풀린다.
- 수정해도 slug(REST `?view=` · MCP 도구 이름)는 그대로다.
- 만들기·수정·삭제는 컬렉션 주인만 — 서버가 검증한다. 초대받은 멤버는 표에서 임시로 걸러 볼 수만 있다.
- 칸이 지워지거나 저장된 출처가 빠지면 뷰는 "쓸 수 없음" 이 된다. REST 422 · MCP 오류 · 알림 정지이고, 웹 표가 원인과 "맞지 않는 조건을 빼고 표에서 고치기" 경로를 보여준다.
