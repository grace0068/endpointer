// 컬렉션 스키마 → MCP 도구 (기획서 12장 · ADR A46)
//
// ── 이 파일이 얇아야 하는 이유 ───────────────────────────────────────────
// 기획서 3장: MCP 는 가장 차별적이지만 구현 난도는 낮다. 스키마와 엔드포인트가 이미
// 있으므로 래퍼는 얇은 계층이다. 여기가 두꺼워지면 설계가 틀린 것이다.
// 그래서 이 파일이 하는 일은 세 가지뿐이다:
//   1. FieldDef[] → zod 입력 스키마 (도구는 **자동 생성**된다. 하드코딩 금지)
//   2. 도구 인자 → REST 쿼리 파라미터 이름 그대로 (12장 표와 1:1)
//   3. core 의 runCollectionRequest 호출 — **REST 라우트와 같은 함수**
// 조건 해석·검증·오류 판단도 응답 조립도 여기서 다시 짜지 않는다 (A46: 같은 입력이면 같은 판단).
// 그래서 입력 스키마는 **타입만** 거른다 — 개수 상한·정수 여부 같은 값 검사는 core 가 해서
// REST 와 같은 코드(limit_exceeded …)·같은 문장으로 실패한다.
//
// ── 문구 규약 ────────────────────────────────────────────────────────────
// 도구 설명과 응답 텍스트는 **사용자의 AI 가 읽는다.** 한국어로 쓰되 사람에게 그대로
// 옮겨져도 되는 말이어야 한다 — 내부 명사(어댑터·런·스펙·드리프트·파서) 금지 (보장선 B2),
// 실패도 상태 문구로 (보장선 B4).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { Db } from '@endpointer/core/db'
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  summarizeViewState,
  type ApiItem,
  type CollectionResponse,
  type FieldDef,
  type FieldType,
  type SchemaResponse,
  type SourceStatus,
  type SourceSummary,
  type SourcesStatusResponse,
} from '@endpointer/core'
import {
  BUILTIN_SORT_KEYS,
  RANGE_FIELD_TYPES,
  RANGE_SUFFIXES,
  RESERVED_PARAMS,
  runCollectionRequest,
  type CollectionRequestInput,
  type CollectionRequestOutcome,
  type StoredView,
} from '@endpointer/core/query'

import type { AccessibleCollection } from './auth'

export interface ToolContext {
  db: Db
  collection: AccessibleCollection
  /** 상대 날짜를 풀 기준 시각 — 테스트가 고정한다. 없으면 지금 */
  now?: () => Date
}

// ── 사람 말로 옮기는 표 ──────────────────────────────────────────────────

/** 필드 타입을 사용자의 AI 가 읽는 말로. 내부 타입 코드를 그대로 노출하지 않는다 */
const TYPE_LABEL: Record<FieldType, string> = {
  text: '글자',
  date: '날짜 YYYY-MM-DD',
  money: '금액 원 단위 정수',
  number: '숫자',
  link: '주소',
  enum: '정해진 선택지',
}

/** 소스 상태 → 상태 문구 (보장선 B4). "실패" 라고 쓰지 않는다 */
const STATUS_LABEL: Record<SourceStatus, string> = {
  ok: '정상',
  healing: '사이트 구조가 바뀐 것 같아 다시 맞추는 중',
  needs_attention: '아직 다시 맞추지 못해 확인이 필요함',
  paused: '사용자가 잠시 멈춰 둠',
}

// ── FieldDef[] → zod 입력 스키마 ─────────────────────────────────────────

type Shape = Record<string, z.ZodTypeAny>

function enumValuesOf(field: FieldDef): string[] {
  if (field.type !== 'enum' || !field.mapping) return []
  return [...new Set(Object.values(field.mapping))].filter((v) => v !== '')
}

/**
 * 값 하나 — 글자·숫자·참거짓을 다 받는다. 타입이 틀린 값도 **core 가** 거절해야
 * REST 와 같은 코드·같은 문장이 나온다 (A46). 어떤 값을 넣어야 하는지는 설명 문구가 말한다.
 */
const scalar = () => z.union([z.string(), z.number(), z.boolean()])

/** 필드 하나의 "완전일치" 파라미터 */
function equalitySchema(_field: FieldDef): z.ZodTypeAny {
  return scalar()
}

/** 범위 파라미터(`_gte` · `_lte`). 기획서 12장 "date/number/money 타입에만" */
function rangeSchema(_field: FieldDef): z.ZodTypeAny {
  return scalar()
}

/**
 * 도구 입력 스키마. **모르는 인자도 통과시킨다**(looseObject) — SDK 기본(strip)은 모르는 인자를
 * 조용히 버려서, REST 에서는 거절되는 오타가 MCP 에서는 무시되고 더 넓은 결과가 나왔다.
 * 통과시킨 인자는 core 가 "이 컬렉션에 없는 조건" 으로 거절한다 (A46).
 */
function toolInput(shape: Shape) {
  return z.looseObject(shape)
}

function describeField(field: FieldDef): string {
  const bits = [`${field.label} · ${TYPE_LABEL[field.type]}`]
  if (field.required) bits.push('항상 값이 있음')
  const values = enumValuesOf(field)
  if (values.length > 0) bits.push(`가능한 값: ${values.join(', ')}`)
  return bits.join(' · ')
}

/** 페이지 인자 — 뷰 도구와 list_items 가 같이 쓴다 */
function pageShape(): Shape {
  return {
    limit: scalar()
      .optional()
      .describe(`한 번에 가져올 개수 (기본 ${DEFAULT_PAGE_LIMIT}, 최대 ${MAX_PAGE_LIMIT}). 넘으면 거절된다`),
    cursor: z
      .string()
      .optional()
      .describe('앞선 응답의 next_cursor 를 그대로 넣으면 그 다음부터 이어서 가져온다. 다른 인자는 앞선 요청과 같아야 한다'),
  }
}

/**
 * `list_items` 의 입력 스키마를 컬렉션 스키마에서 만든다.
 *
 * 이름 규약은 REST 와 **글자 그대로 같다** (기획서 12장 표):
 *   `{필드키}` · `{필드키}_gte` · `{필드키}_lte` · q · source · since · sort · limit · cursor · include
 * 같은 이름이라서 아래 handler 가 인자를 그대로 core 에 넘길 수 있고,
 * 그 덕에 MCP 와 REST 의 동작이 구조적으로 갈라지지 않는다.
 */
export function buildListItemsShape(fields: readonly FieldDef[]): Shape {
  const shape: Shape = {}
  const fieldKeys = new Set(fields.map((f) => f.key))
  const reserved = new Set<string>(RESERVED_PARAMS)

  for (const field of fields) {
    // 필드 키가 제어용 이름과 겹치면 제어용이 이긴다 (core 의 params.ts 도 같은 순서다)
    if (reserved.has(field.key)) continue
    shape[field.key] = equalitySchema(field).optional().describe(describeField(field))
  }

  for (const field of fields) {
    if (!RANGE_FIELD_TYPES.includes(field.type)) continue
    for (const suffix of RANGE_SUFFIXES) {
      const name = `${field.key}${suffix}`
      if (fieldKeys.has(name) || reserved.has(name)) continue
      const bound = suffix === '_gte' ? '이상' : '이하'
      shape[name] = rangeSchema(field)
        .optional()
        .describe(`${field.label}이(가) 이 값 ${bound}인 것만`)
    }
  }

  const sortable = [...fields.map((f) => f.key), ...BUILTIN_SORT_KEYS]

  shape['q'] = z.string().optional().describe('글자 항목 전체에서 이 말이 들어간 것만 찾는다. 한 낱말이 가장 잘 맞는다')
  shape['source'] = z.string().optional().describe('특정 출처의 것만. 값은 사이트 주소(예: k-startup.go.kr)')
  shape['since'] = z
    .string()
    .optional()
    .describe('이 날짜 이후에 처음 올라온 것만. YYYY-MM-DD 형식 ("새로 올라온 것" 질문에 쓴다)')
  shape['sort'] = z
    .string()
    .optional()
    .describe(`정렬 기준. 앞에 -를 붙이면 큰 값부터. 쓸 수 있는 값: ${sortable.join(', ')}`)
  Object.assign(shape, pageShape())
  shape['include'] = z
    .string()
    .optional()
    .describe('provenance 를 넣으면 각 값이 원문 어디에서 왔는지도 함께 준다')

  return shape
}

/**
 * 도구 인자 → URLSearchParams 재료.
 * 이름이 REST 와 같으므로 값만 문자열로 바꿔 그대로 넘긴다.
 */
export function argsToQueryParams(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      if (value.trim() === '') continue
      out[name] = value
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[name] = String(value)
      continue
    }
    if (Array.isArray(value)) {
      const joined = value.filter((v) => typeof v === 'string' || typeof v === 'number').join(',')
      if (joined !== '') out[name] = joined
      continue
    }
    // 객체처럼 조건으로 쓸 수 없는 모양도 버리지 않는다 — 글자로 넘겨 core 가 거절하게 한다 (A46)
    out[name] = JSON.stringify(value)
  }
  return out
}

// ── 응답을 사람이 읽는 텍스트로 ──────────────────────────────────────────

function formatValue(field: FieldDef, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (field.type === 'money' && typeof raw === 'number') return `${raw.toLocaleString('ko-KR')}원`
  if (field.type === 'number' && typeof raw === 'number') return raw.toLocaleString('ko-KR')
  return String(raw)
}

export function renderItem(item: ApiItem, fields: readonly FieldDef[], index: number): string {
  const title = fields.find((f) => f.type === 'text' && f.required) ?? fields.find((f) => f.type === 'text')
  const head = (title ? formatValue(title, item[title.key]) : null) ?? '(제목 없음)'

  const rest = fields
    .filter((f) => f.key !== title?.key && f.type !== 'link')
    .map((f) => {
      const v = formatValue(f, item[f.key])
      return v === null ? null : `${f.label}: ${v}`
    })
    .filter((v): v is string => v !== null)

  const lines = [`${index + 1}. ${head}`]
  if (rest.length > 0) lines.push(`   ${rest.join(' · ')}`)
  lines.push(`   출처: ${item._source}${item._link ? ` · ${item._link}` : ''}`)
  return lines.join('\n')
}

/** 원칙 ④ — 어떤 표면에서든 "지금 어디가 성한지" 가 같이 나온다 */
export function renderSources(sources: Record<string, SourceSummary>): string {
  const entries = Object.entries(sources)
  if (entries.length === 0) return '아직 연결된 사이트가 없습니다.'
  return entries
    .map(([host, s]) => {
      const bits = [`${host}: ${STATUS_LABEL[s.status]} · ${s.items}건`]
      if (s.age) bits.push(`마지막으로 받아온 지 ${s.age} 지난 내용입니다`)
      else if (s.status !== 'ok' && s.last_ok_at) bits.push(`마지막 정상 시각 ${s.last_ok_at}`)
      return `- ${bits.join(' · ')}`
    })
    .join('\n')
}

export function renderCollectionResponse(response: CollectionResponse, collection: AccessibleCollection): string {
  const fields = collection.schema_json
  const blocks: string[] = []
  const { total, offset } = response.page
  const count = response.items.length

  blocks.push(
    count === 0
      ? `${collection.name} — 조건에 맞는 항목이 없습니다.`
      : `${collection.name} — 전체 ${total}개 중 ${offset + 1}–${offset + count}번째`,
  )

  if (count > 0) {
    blocks.push(response.items.map((item, i) => renderItem(item, fields, offset + i)).join('\n'))
  }

  blocks.push(`[사이트 상태]\n${renderSources(response.sources)}`)

  if (response.page.next_cursor) {
    blocks.push(`더 있습니다. 이어서 보려면 같은 인자에 cursor="${response.page.next_cursor}" 를 더해 다시 부르세요.`)
  }

  return blocks.join('\n\n')
}

/**
 * structuredContent 는 **REST 응답과 완전히 같은 객체**로 둔다 (G0 계약 (2)).
 * 두 표면이 같은 모양을 내야 "표면이 넷이지만 데이터는 하나" 가 참이 된다.
 */
function structured(value: object): Record<string, unknown> {
  return value as Record<string, unknown>
}

function textResult(text: string, data: object): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured(data) }
}

/**
 * 실패 — REST 의 오류 본문과 같은 `{error:{code,message,problems}}` 를 싣는다 (A46).
 * 같은 입력이면 REST 가 낸 code 와 여기의 code 가 같다. 스택 트레이스는 내보내지 않는다 (B4).
 */
export function errorResult(code: string, message: string, problems: readonly unknown[] = []): CallToolResult {
  const lines = [message]
  if (problems.length > 1) {
    for (const p of problems) {
      const m = (p as { message?: unknown }).message
      if (typeof m === 'string') lines.push(`- ${m}`)
    }
  }
  // 코드는 글에도 싣는다 — 클라이언트에 따라 오류 결과의 structuredContent 를 모델에게 안 보여준다
  // (Claude Code 로 실제 연결해 확인: 모델이 "오류 코드가 없다" 고 보고했다). REST 의 error.code 와 같은 값이다
  lines.push(`(오류 코드: ${code})`)
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { error: { code, message, ...(problems.length > 0 ? { problems } : {}) } },
    isError: true,
  }
}

function outcomeResult(outcome: CollectionRequestOutcome, collection: AccessibleCollection): CallToolResult {
  if (!outcome.ok) return errorResult(outcome.code, outcome.message, outcome.problems)
  return textResult(renderCollectionResponse(outcome.response, collection), outcome.response)
}

async function run(ctx: ToolContext, input: CollectionRequestInput): Promise<CallToolResult> {
  const outcome = await runCollectionRequest(ctx.db, ctx.collection, { ...input, now: ctx.now?.() ?? new Date() })
  return outcomeResult(outcome, ctx.collection)
}

// ── 도구 등록 ────────────────────────────────────────────────────────────

function collectionOverview(collection: AccessibleCollection): string {
  const fields = collection.schema_json
    .map((f) => `${f.key}(${TYPE_LABEL[f.type]}${f.required ? ', 항상 있음' : ''})`)
    .join(' · ')
  return fields === '' ? '아직 항목 구성이 정해지지 않았습니다.' : fields
}

export function registerCollectionTools(server: McpServer, ctx: ToolContext): void {
  const { collection } = ctx
  const fields = collection.schema_json

  // ── list_items ─────────────────────────────────────────────────────────
  server.registerTool(
    'list_items',
    {
      title: `${collection.name} 목록 보기`,
      description: [
        `"${collection.name}" 컬렉션의 항목을 조건으로 걸러서 가져온다.`,
        `항목 구성: ${collectionOverview(collection)}`,
        '조건은 전부 선택이고, 아무것도 안 주면 최근에 올라온 순서로 보여준다.',
        '이해하지 못한 조건이 있으면 결과를 내지 않고 무엇이 틀렸는지 알려준다 — 그 조건을 고쳐 다시 부른다.',
        '결과를 내면 항목과 함께 사이트별 상태가 언제나 들어 있다 — 일부 사이트가 잠시 막혀 있어도 나머지는 그대로 나온다. 조건이 틀려 거절될 때는 결과 대신 오류 문장과 오류 코드만 온다.',
      ].join('\n'),
      inputSchema: toolInput(buildListItemsShape(fields)),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(ctx, { params: argsToQueryParams(args as Record<string, unknown>) }),
  )

  // ── search_items ───────────────────────────────────────────────────────
  server.registerTool(
    'search_items',
    {
      title: `${collection.name} 검색`,
      description: [
        `"${collection.name}" 에서 찾고 싶은 말로 검색한다. 글자로 된 항목 전체가 대상이다.`,
        '문장 전체보다 핵심 낱말 하나가 가장 잘 맞는다. 예) "이번 주 마감인 창업 지원사업" → "창업"',
        '기간이나 금액 조건까지 걸어야 하면 list_items 를 쓴다.',
      ].join('\n'),
      inputSchema: toolInput({
        query: z.string().min(1).describe('찾을 말. 핵심 낱말 하나를 권한다'),
        ...pageShape(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    // 검색은 list_items 의 `?q=` 와 같은 길로 간다. 별도 검색 경로를 만들지 않는다
    async (args) => {
      const { query, ...page } = args as { query: string } & Record<string, unknown>
      // q 를 따로 주면 query 와 겹친다 — 하나만 쓰게 한다 (조용히 하나를 고르지 않는다)
      if ('q' in page) return errorResult('invalid_query', '검색어는 query 하나로만 주세요 (q 와 함께 줄 수 없습니다)')
      return run(ctx, { params: { ...argsToQueryParams(page), q: query } })
    },
  )

  // ── get_schema ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_schema',
    {
      title: `${collection.name} 항목 구성`,
      description: `"${collection.name}" 에 어떤 항목이 있고 각 항목이 어떤 값인지 알려준다. list_items 에 어떤 조건을 걸 수 있는지 확인할 때 먼저 부른다.`,
      annotations: { readOnlyHint: true },
    },
    () => {
      const payload: SchemaResponse = {
        slug: collection.slug,
        name: collection.name,
        schema_version: collection.schema_version,
        fields: [...fields],
      }
      const lines = fields.map((f) => {
        const bits = [`- ${f.key} — ${describeField(f)}`]
        if (RANGE_FIELD_TYPES.includes(f.type)) bits.push(`  범위 조건 가능: ${f.key}_gte · ${f.key}_lte`)
        return bits.join('\n')
      })
      const text = [
        `${collection.name} (주소 이름: ${collection.slug}) · 구성 ${collection.schema_version}번째 판`,
        lines.length > 0 ? lines.join('\n') : '아직 항목 구성이 정해지지 않았습니다.',
      ].join('\n')
      return textResult(text, payload)
    },
  )

  // ── get_sources_status ─────────────────────────────────────────────────
  server.registerTool(
    'get_sources_status',
    {
      title: `${collection.name} 사이트 상태`,
      description: `"${collection.name}" 이 어느 사이트에서 오는지, 각 사이트가 지금 정상인지, 마지막으로 언제 받아왔는지 알려준다. 데이터가 오래돼 보이거나 수가 적어 보일 때 확인한다.`,
      annotations: { readOnlyHint: true },
    },
    async () => {
      // 상태만 필요하지만 응답 조립은 core 것을 그대로 쓴다. 가장 작은 페이지로 부른다
      const outcome = await runCollectionRequest(ctx.db, collection, { params: { limit: '1' } })
      if (!outcome.ok) return errorResult(outcome.code, outcome.message, outcome.problems)
      const payload: SourcesStatusResponse = { sources: outcome.response.sources }
      return textResult(`${collection.name} 의 사이트 상태\n${renderSources(outcome.response.sources)}`, payload)
    },
  )
}

// ── 뷰별 도구 (뷰 계약 §4 · 델타 2-4 · A46) ──────────────────────────────
// `search_items(view=…)` 가 아니라 **뷰마다 도구 하나** — 도구 설명에 뷰 이름·조건이
// 그대로 들어가야 클라이언트 LLM 이 "이번 달 마감 뭐 있어?" 를 바로 맞는 도구로 잇는다.
// 실행은 REST `?view=` 와 같은 함수다 — 깨진 뷰·커서 판단이 갈라지지 않는다.

/** 고정 도구 4개와 이름이 겹치면 뷰 쪽을 양보시킨다 (slug 규칙상 언더스코어가 없어 실제로는 안 겹친다) */
const FIXED_TOOL_NAMES = new Set(['list_items', 'search_items', 'get_schema', 'get_sources_status'])

export function registerViewTools(server: McpServer, ctx: ToolContext, views: readonly StoredView[]): void {
  const fields = ctx.collection.schema_json

  for (const view of views) {
    const toolName = FIXED_TOOL_NAMES.has(view.slug) ? `view-${view.slug}` : view.slug
    const summary = summarizeViewState(view.state, fields)

    server.registerTool(
      toolName,
      {
        title: view.name,
        description: [
          `사용자가 저장해 둔 조건 "${view.name}" 에 지금 맞는 항목을 가져온다.`,
          summary === '' ? '조건 없이 전체를 본다.' : `조건: ${summary}`,
          '이 조건에 대한 질문이면 list_items 로 조건을 다시 만들지 말고 이 도구를 그대로 부른다.',
          '결과가 더 있으면 응답의 next_cursor 를 cursor 로 넣어 이어서 가져온다.',
        ].join('\n'),
        inputSchema: toolInput(pageShape()),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args) => run(ctx, { params: argsToQueryParams(args as Record<string, unknown>), viewSlug: view.slug }),
    )
  }
}

/**
 * 서버 수준 안내 — 커넥터가 붙자마자 클라이언트 LLM 에게 한 번 전달된다.
 * 도구 이름을 외우게 하는 게 아니라 "먼저 무엇을 물어보면 되는지" 를 알려주는 자리다.
 */
export function instructionsFor(collection: AccessibleCollection, viewNames: readonly string[] = []): string {
  return [
    `이 서버는 "${collection.name}" 컬렉션 하나를 다룬다. 여러 사이트에서 모은 항목이 한 표로 합쳐져 있다.`,
    `항목 구성: ${collectionOverview(collection)}`,
    ...(viewNames.length > 0
      ? [`사용자가 저장해 둔 조건이 도구로 나와 있다: ${viewNames.join(' · ')}. 그 조건에 대한 질문이면 그 도구를 먼저 쓴다.`]
      : []),
    '조건이 붙는 질문이면 list_items, 찾는 말이 있으면 search_items 를 쓴다.',
    '어떤 조건을 걸 수 있는지 모르겠으면 get_schema 를 먼저 부른다.',
    '결과에는 사이트별 상태가 늘 함께 온다. 어떤 사이트가 "다시 맞추는 중" 이면 그 사이트 몫은 마지막으로 받아온 내용이라는 뜻이니, 사용자에게 그 사실을 같이 알려 준다. 조건이 틀리면 결과 없이 오류 문장과 오류 코드가 온다 — 조건을 고쳐 다시 부른다.',
  ].join('\n')
}
