// 어댑터 스펙 — LLM 이 만드는 것은 코드가 아니라 이 JSON 이다 (기획서 11장 · 원칙 ② · ADR A2)
//
// 이 스키마가 단일 출처다. 세 곳이 같은 정의를 본다:
//   1. `packages/core` 의 해석기 (스펙을 읽어 실행)
//   2. 검증기 (실행 전 형태 검사 — 기획서 11장 "스펙 검증")
//   3. Gemini 구조화 출력(`responseSchema`) 프롬프트
//
// ── 경로 문법 ──────────────────────────────────────────────────────────
//   JSONPath : `$.` 로 시작한다.        예) `$.data.items[*]`, `$.pbancSn`
//   CSS      : `css:` 접두사를 붙인다.  예) `css:.contest-list > li`
//   속성 추출: CSS 뒤에 `@속성`.        예) `css:a@href`
//
// 어느 문법이어야 하는지는 **fetch.mode 가 정하고, 그 매핑의 단일 출처가 `pathSyntaxFor` 다** (ADR A43 ③):
//   json · inline_json → JSONPath          html · browser → CSS
// 불리언(`mode === 'json'`)으로 판단하지 마라 — 모드가 늘면 조용히 틀린다.

import { z } from 'zod'
import { FieldTypeSchema, FIELD_KEY_PATTERN } from '../types/collection'
import type { FetchMode } from '../types/source'
import { TransformPipelineSchema } from './ops'

/** 현재 스펙 버전. 구조가 바뀌면 올린다 */
export const CURRENT_SPEC_VERSION = 1

/** 페이지네이션 상한 (ADR A12 — 5일 범위에서 무한 크롤 금지) */
export const MAX_PAGES = 3

// ── 경로 문법 ──────────────────────────────────────────────────────────

/** `$` 또는 `$.`/`$[` 로 시작하는 JSONPath */
export const JSONPATH_PATTERN = /^\$(?:$|[.[])/
/** `css:선택자` 뒤에 선택적으로 `@속성` */
export const CSS_PATH_PATTERN = /^css:\s*(?<selector>[^@]+?)\s*(?:@(?<attr>[A-Za-z_:][-A-Za-z0-9_:.]*))?$/

export function isJsonPath(path: string): boolean {
  return JSONPATH_PATTERN.test(path)
}

export function isCssPath(path: string): boolean {
  return CSS_PATH_PATTERN.test(path)
}

// ── 모드 → 경로 문법 (단일 출처 · ADR A43 ③) ──────────────────────────

/** 경로 문법 두 가지. 모드가 늘어도 문법은 이 둘뿐이다 */
export const PATH_SYNTAXES = ['jsonpath', 'css'] as const
export type PathSyntax = (typeof PATH_SYNTAXES)[number]

/**
 * 모드마다 어떤 경로 문법을 쓰는지. **이 표가 유일한 출처다.**
 *
 * 새 모드를 추가하면 여기 한 줄을 더하는 것으로 끝나야 한다 — 그래서 `Record<FetchMode, …>` 다.
 * 타입이 빠뜨린 모드를 잡아준다.
 */
export const PATH_SYNTAX_BY_MODE: Record<FetchMode, PathSyntax> = {
  json: 'jsonpath',
  // HTML 을 받지만 값은 script 안의 JSON 에서 읽는다 — 그래서 CSS 가 아니라 JSONPath 다
  inline_json: 'jsonpath',
  html: 'css',
  browser: 'css',
}

/** 이 모드의 경로 문법. `mode === 'json'` 같은 불리언 판정을 대체한다 */
export function pathSyntaxFor(mode: FetchMode): PathSyntax {
  return PATH_SYNTAX_BY_MODE[mode]
}

/** 그 문법인지 검사하는 함수 */
export function pathCheckerFor(syntax: PathSyntax): (path: string) => boolean {
  return syntax === 'jsonpath' ? isJsonPath : isCssPath
}

/** 오류 문장에 쓸 사람 말 */
export function pathSyntaxLabel(syntax: PathSyntax): string {
  return syntax === 'jsonpath' ? "JSONPath('$.' 로 시작)" : "CSS 경로('css:' 로 시작)"
}

/** `css:a@href` → `{ selector: 'a', attr: 'href' }`. CSS 경로가 아니면 null */
export function parseCssPath(path: string): { selector: string; attr: string | null } | null {
  const m = CSS_PATH_PATTERN.exec(path)
  const selector = m?.groups?.['selector']
  if (!selector) return null
  return { selector, attr: m?.groups?.['attr'] ?? null }
}

/** JSONPath 이거나 CSS 경로. 어느 쪽이어야 하는지는 fetch.mode 가 정한다 */
export const PathSchema = z
  .string()
  .min(1)
  .refine((p) => isJsonPath(p) || isCssPath(p), {
    message: "경로는 '$.' 로 시작하는 JSONPath 이거나 'css:' 로 시작하는 CSS 선택자여야 합니다",
  })

const HttpUrlSchema = z
  .string()
  .min(1)
  .refine((u) => /^https?:\/\//.test(u), { message: 'URL 은 http:// 또는 https:// 로 시작해야 합니다' })

// ── fetch (mode 판별 유니온) ───────────────────────────────────────────

/** 내부 JSON 엔드포인트를 찾은 경우 (원칙 ③ — 가장 안정적인 경로) */
export const JsonFetchSpecSchema = z.strictObject({
  mode: z.literal('json'),
  /**
   * `{page}` 자리표시자로 페이지를 넘긴다.
   * `{today}`(YYYYMMDD) · `{today_iso}`(YYYY-MM-DD) 는 매 수집 순간의 오늘 날짜(KST)로 바뀐다 —
   * 상영시간표·예약 현황처럼 날짜가 파라미터로 들어가는 API 를 매일 갱신되게 한다.
   * 절대 날짜를 박으면 그 하루만 보고 다음날 죽으므로, 오늘 날짜가 필요하면 반드시 이 자리표시자를 쓴다.
   */
  url: HttpUrlSchema,
  method: z.enum(['GET', 'POST']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * POST 요청 본문 (JSON 문자열). method 가 POST 일 때만 의미가 있다.
   * url 과 같은 자리표시자(`{today}`·`{today_iso}`)를 쓸 수 있다 — 예: `{"playDe":"{today}"}`.
   */
  body: z.string().optional(),
})

// ── 인라인 JSON (ADR A43) ─────────────────────────────────────────────
//
// 어떤 사이트는 목록을 HTML 태그가 아니라 페이지 안 `<script>` 의 JSON 으로 들고 있다.
// HTML 을 받아오지만 값은 JSONPath 로 읽어야 하는 조합이 이 모드다.
//
// **스펙에 적는 것은 "어느 스크립트인가" 뿐이다.** 벗기는 방법은 코드에 고정돼 있고
// 파서는 `JSON.parse` 하나다 (`inline-script.ts`). 벗기기 규칙을 스펙에서 조립할 수 있게
// 열면 그것이 곧 표현식 평가의 앞문이고 원칙 ②(샌드박스 불필요)가 무너진다.

/** 스크립트를 가리키는 네 가지 방법. **닫힌 집합이다** (A43 ①) */
export const ScriptLocatorSchema = z.discriminatedUnion('kind', [
  /** `<script id="__NEXT_DATA__" type="application/json">` 처럼 id 로 찾는다 */
  z.strictObject({
    kind: z.literal('id'),
    id: z.string().min(1),
    /**
     * 내용의 형식. `json` 은 순수 JSON(기본),
     * `devalue` 는 Nuxt 3 `__NUXT_DATA__` 의 눕힌 배열이다 (값이 한 배열에 눕고 자리에는 인덱스가 온다).
     */
    format: z.enum(['json', 'devalue']).default('json'),
  }),
  /**
   * `window.__INITIAL_STATE__ = {…};` 처럼 전역에 대입된 객체 리터럴.
   * 이름 → 첫 `=` → 괄호 짝이 맞는 조각 하나 → `JSON.parse` 가 전부다.
   * 함수 호출(`=(function(){…})()`)·문자열 연결은 JSON 이 아니므로 **못 읽고, 읽으려 하지도 않는다.**
   */
  z.strictObject({ kind: z.literal('global'), name: z.string().min(1) }),
  /**
   * `<script type="application/ld+json">` 중 **`@type` 이 `ItemList` 인 것**을 찾는다.
   * 순번으로 가리키지 않는다 — 사이트가 스크립트 하나만 더해도 순번은 밀린다 (A43 재검토 조건 ①).
   */
  z.strictObject({ kind: z.literal('ld_json') }),
  /**
   * 이름 없는 `<script type="application/json">` 중 n 번째 (0부터).
   * **순번이라 취약하다** — 치유(재컴파일)가 받아내는 것을 전제로 둔다 (A43 재검토 조건 ①).
   */
  z.strictObject({ kind: z.literal('json_script'), index: z.number().int().min(0).max(50) }),
])

export type ScriptLocator = z.infer<typeof ScriptLocatorSchema>
export type ScriptLocatorInput = z.input<typeof ScriptLocatorSchema>

/** HTML 을 받아 `script` 안의 JSON 을 꺼낸다. 모든 경로는 JSONPath 다 */
export const InlineJsonFetchSpecSchema = z.strictObject({
  mode: z.literal('inline_json'),
  url: HttpUrlSchema,
  /** 어느 스크립트에서 꺼낼지 */
  script: ScriptLocatorSchema,
})

/** HTML 폴백 */
export const HtmlFetchSpecSchema = z.strictObject({
  mode: z.literal('html'),
  url: HttpUrlSchema,
})

/** Playwright 로 열고 `wait_for` 후 DOM 을 잡는다 */
export const BrowserFetchSpecSchema = z.strictObject({
  mode: z.literal('browser'),
  url: HttpUrlSchema,
  /** `networkidle` 이거나 기다릴 CSS 선택자 (`css:` 접두사 포함) */
  wait_for: z
    .union([z.literal('networkidle'), z.string().refine(isCssPath, { message: "선택자는 'css:' 로 시작해야 합니다" })])
    .default('networkidle'),
})

export const FetchSpecSchema = z.discriminatedUnion('mode', [
  JsonFetchSpecSchema,
  InlineJsonFetchSpecSchema,
  HtmlFetchSpecSchema,
  BrowserFetchSpecSchema,
])

export type FetchSpec = z.infer<typeof FetchSpecSchema>
export type JsonFetchSpec = z.infer<typeof JsonFetchSpecSchema>
export type InlineJsonFetchSpec = z.infer<typeof InlineJsonFetchSpecSchema>
export type HtmlFetchSpec = z.infer<typeof HtmlFetchSpecSchema>
export type BrowserFetchSpec = z.infer<typeof BrowserFetchSpecSchema>

// ── pagination (kind 판별 유니온) ──────────────────────────────────────

export const PAGINATION_KINDS = ['page_param', 'next_link', 'scroll', 'none'] as const
export type PaginationKind = (typeof PAGINATION_KINDS)[number]
export const PaginationKindSchema = z.enum(PAGINATION_KINDS)

/** 상한은 ADR A12 로 고정. LLM 이 더 큰 값을 내면 파싱 단계에서 거부된다 */
const MaxPagesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGES, `한 번에 ${MAX_PAGES}페이지를 넘겨 읽지 않습니다`)
  .default(MAX_PAGES)

/** `?page=1` 처럼 쿼리 파라미터로 페이지를 넘긴다. fetch.url 에 `{page}` 가 있어야 한다 */
export const PageParamPaginationSchema = z.strictObject({
  kind: z.literal('page_param'),
  param: z.string().min(1),
  start: z.number().int().min(0).default(1),
  max_pages: MaxPagesSchema,
})

/** 다음 페이지 링크를 경로로 집는다 */
export const NextLinkPaginationSchema = z.strictObject({
  kind: z.literal('next_link'),
  path: PathSchema,
  max_pages: MaxPagesSchema,
})

/** 무한 스크롤 — browser 모드에서만 의미가 있다 */
export const ScrollPaginationSchema = z.strictObject({
  kind: z.literal('scroll'),
  times: z.number().int().min(1).max(MAX_PAGES).default(MAX_PAGES),
})

/** 한 페이지가 전부 */
export const NonePaginationSchema = z.strictObject({ kind: z.literal('none') })

export const PaginationSpecSchema = z.discriminatedUnion('kind', [
  PageParamPaginationSchema,
  NextLinkPaginationSchema,
  ScrollPaginationSchema,
  NonePaginationSchema,
])

export type PaginationSpec = z.infer<typeof PaginationSpecSchema>

// ── 필드 ───────────────────────────────────────────────────────────────

export const FieldSpecSchema = z.strictObject({
  /** JSONPath 또는 CSS 경로. fetch.mode 와 문법이 맞아야 한다 */
  path: PathSchema,
  type: FieldTypeSchema,
  /** 위에서부터 순서대로 적용되는 변환 파이프라인 (닫힌 집합) */
  transform: TransformPipelineSchema.optional(),
})

export type FieldSpec = z.infer<typeof FieldSpecSchema>

// ── 어댑터 스펙 ────────────────────────────────────────────────────────

const AdapterSpecObjectSchema = z.strictObject({
  spec_version: z.number().int().min(1).default(CURRENT_SPEC_VERSION),
  fetch: FetchSpecSchema,
  /** 목록 하나하나를 집는 경로. 예) `$.data.items[*]`, `css:.contest-list > li` */
  list: PathSchema,
  /**
   * 소스 안에서 안정적인 고유 키 (ADR A13).
   * 못 고르면 생략한다 — 해석기가 정규화된 title 해시로 폴백한다 (기획서 10장).
   */
  dedupe_key: PathSchema.optional(),
  /** 키는 컬렉션 스키마의 필드 키와 같다 */
  fields: z.record(z.string().regex(FIELD_KEY_PATTERN), FieldSpecSchema),
  pagination: PaginationSpecSchema.default({ kind: 'none' }),
})

/**
 * 실행 전 형태 검사를 통과한 어댑터 스펙 (기획서 11장 "스펙 검증").
 * 프롬프트 신뢰가 아니라 계약 검사다.
 */
export const AdapterSpecSchema = AdapterSpecObjectSchema.superRefine((spec, ctx) => {
  const mode = spec.fetch.mode
  // 모드와 문법의 관계는 PATH_SYNTAX_BY_MODE 하나가 정한다 (A43 ③)
  const syntax = pathSyntaxFor(mode)
  const expected = pathSyntaxLabel(syntax)
  const ok = pathCheckerFor(syntax)

  const check = (path: string, at: (string | number)[]): void => {
    if (!ok(path)) {
      ctx.addIssue({
        code: 'custom',
        path: at,
        message: `${mode} 모드에서는 경로가 ${expected} 여야 합니다`,
      })
    }
  }

  check(spec.list, ['list'])
  if (spec.dedupe_key !== undefined) check(spec.dedupe_key, ['dedupe_key'])
  for (const [key, field] of Object.entries(spec.fields)) {
    check(field.path, ['fields', key, 'path'])
  }
  if (spec.pagination.kind === 'next_link') {
    check(spec.pagination.path, ['pagination', 'path'])
  }

  if (Object.keys(spec.fields).length === 0) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: '필드가 하나도 없습니다' })
  }

  // page_param 은 URL 에 자리표시자가 있어야 실제로 페이지가 넘어간다
  if (spec.pagination.kind === 'page_param' && !spec.fetch.url.includes('{page}')) {
    ctx.addIssue({
      code: 'custom',
      path: ['fetch', 'url'],
      message: 'page_param 페이지네이션을 쓰려면 URL 에 {page} 자리표시자가 있어야 합니다',
    })
  }

  // 무한 스크롤은 브라우저를 띄워야만 가능하다
  if (spec.pagination.kind === 'scroll' && mode !== 'browser') {
    ctx.addIssue({
      code: 'custom',
      path: ['pagination', 'kind'],
      message: 'scroll 페이지네이션은 browser 모드에서만 쓸 수 있습니다',
    })
  }
})

export type AdapterSpec = z.infer<typeof AdapterSpecSchema>
/** 파싱 전 형태 (기본값이 아직 안 채워진 상태) — LLM 출력·저장된 JSON 을 받을 때 쓴다 */
export type AdapterSpecInput = z.input<typeof AdapterSpecSchema>

/**
 * `fetch.url` 의 호스트가 사용자가 준 호스트와 같은지 (기획서 11장 스펙 검증 첫 항목).
 * LLM 이 엉뚱한 사이트로 나가는 것을 막는다.
 */
export function specTargetsHost(spec: AdapterSpec, host: string): boolean {
  try {
    const actual = new URL(spec.fetch.url.replace('{page}', '1')).hostname.toLowerCase()
    const expected = host.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    return actual === expected || actual.endsWith(`.${expected}`) || expected.endsWith(`.${actual}`)
  } catch {
    return false
  }
}
