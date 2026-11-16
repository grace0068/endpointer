// 컬렉션 쿼리 — 기획서 12장 REST 계약의 단일 출처
//
// web 의 `GET /api/v1/{slug}` 와 mcp 의 `list_items` 가 **같은 코드**를 쓴다.
// 두 표면이 파라미터 표를 따로 구현하면 반드시 갈라지고, 갈라지는 순간
// "내 API 하나" 라는 제품 약속이 거짓말이 된다.
//
//   runCollectionRequest   표·REST·MCP 공통 본체 — 뷰 읽기·판정 → 해석 → 실행 (A46)
//   resolveCollectionRequest  파라미터 + (뷰 위에 AND) + 커서 확인 → 쿼리 (순수)
//   parseCollectionQuery   URLSearchParams → CollectionQuery | 문제 목록 (throw 하지 않는다)
//   planItemsQuery         CollectionQuery → where / orderBy / 커서
//   buildCollectionResponse  → G0 계약 (2) 응답. sources 는 언제나 포함된다

export * from './params'
export * from './build'
export * from './respond'
export * from './view'
export * from './resolve'
export * from './matches'
