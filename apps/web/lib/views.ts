// 뷰 — 저장·수정·조회 (뷰 계약 · A33~A35 · A47).
//
// 읽기와 판정은 core 의 loadStoredViews/parseStoredView 다 — REST `?view=`·MCP 뷰 도구·워커 알림이
// 같은 판정을 본다. 조건 해석은 core 의 runCollectionRequest 하나다 (A46).
// 여기서 하는 것은 저장(views 테이블)과 화면용 문장뿐이다.
//
// ── 저장하는 것 (A47) ────────────────────────────────────────────────────
//   조회 상태  where · sort(첫 항목) · q · source   → 웹·REST·MCP 가 같은 뜻으로 적용
//   표시 설정  columns (열 표시·순서)               → 웹에서만 복원
// 수정해도 slug 는 그대로다 — REST `?view=` 와 AI 도구 이름이 slug 를 물고 있다.
//
// ── 권한 ─────────────────────────────────────────────────────────────────
// 만들기·고치기·지우기는 전부 행위자를 받아 requireManager 를 지난다. 읽기 전용 멤버는
// 표에서 임시로 걸러 볼 수만 있다 (A40·A47).

import {
  MAX_VIEWS_PER_COLLECTION,
  ViewDefinitionSchema,
  pruneViewColumns,
  suggestViewSlug,
  summarizeViewState,
  validateViewDefinition,
  type FieldDef,
  type ViewHealth,
} from '@endpointer/core'
import { loadSourceStates, loadStoredView, loadStoredViews, type StoredView } from '@endpointer/core/query'

import type { CollectionRecord } from './collections'
import { safeQuery, type Loaded } from './db'
import { requireManager, type Actor } from './permissions'
import type { TableState } from './table-state'

export type ViewRecord = StoredView

type ViewCollection = Pick<CollectionRecord, 'id' | 'owner_id' | 'schema_json'>

async function hostsOf(core: typeof import('@endpointer/core/db'), collectionId: string): Promise<string[]> {
  const rows = await loadSourceStates(core.db, collectionId)
  return [...new Set(rows.map((r) => r.host))]
}

/** 이 컬렉션의 저장된 뷰들 (고정 먼저, 만든 순) — 판정까지 마친 상태 */
export async function listViews(collection: Pick<CollectionRecord, 'id' | 'schema_json'>): Promise<Loaded<ViewRecord[]>> {
  return safeQuery(async (core) => loadStoredViews(core.db, collection.id, collection.schema_json, await hostsOf(core, collection.id)))
}

export async function getViewBySlug(
  collection: Pick<CollectionRecord, 'id' | 'schema_json'>,
  slug: string,
): Promise<Loaded<ViewRecord | null>> {
  return safeQuery(async (core) =>
    loadStoredView(core.db, collection.id, slug, collection.schema_json, await hostsOf(core, collection.id)),
  )
}

/** 저장 결과 — 실패도 사람 문장 (B4) */
export type ViewWriteResult = { ok: true; slug: string } | { ok: false; message: string }

export interface ViewInput {
  name: string
  state: TableState
}

/** 모양(zod) → 스키마·출처 대조 → 저장할 정의. 실패면 첫 문장 */
function toDefinition(
  input: ViewInput,
  fields: readonly FieldDef[],
  hosts: readonly string[],
): { ok: true; def: ReturnType<typeof ViewDefinitionSchema.parse> } | { ok: false; message: string } {
  const parsed = ViewDefinitionSchema.safeParse({
    name: input.name,
    where: input.state.where,
    sort: input.state.sort.slice(0, 1),
    q: input.state.q,
    source: input.state.source,
    columns: pruneViewColumns(input.state.columns, fields).columns,
  })
  if (!parsed.success) return { ok: false, message: '조건을 읽지 못했어요. 화면을 새로 고쳐 주세요.' }
  const check = validateViewDefinition(parsed.data, fields, hosts)
  if (!check.ok) return { ok: false, message: check.errors[0] ?? '조건이 이 표와 맞지 않아요.' }
  return { ok: true, def: parsed.data }
}

function nameProblem(name: string): string | null {
  const t = name.trim()
  if (t === '') return '조건의 이름을 지어 주세요.'
  if (t.length > 60) return '이름이 너무 길어요. 60자 안으로 지어 주세요.'
  return null
}

/**
 * 지금 보는 상태를 새 뷰로 저장한다. 상한은 서버가 거부한다 (계약 §5 — 화면 안내만으론 우회된다).
 */
export async function createView(
  collection: ViewCollection,
  actor: Actor,
  input: ViewInput,
): Promise<ViewWriteResult> {
  const badName = nameProblem(input.name)
  if (badName !== null) return { ok: false, message: badName }

  const guard = await requireManager(collection, actor)
  if (!guard.ok) return guard

  const result = await safeQuery(async (core): Promise<ViewWriteResult> => {
    const hosts = await hostsOf(core, collection.id)
    const def = toDefinition({ ...input, name: input.name.trim() }, collection.schema_json, hosts)
    if (!def.ok) return def

    const sql = core.queryClient
    const countRows = await sql<{ n: number }[]>`select count(*)::int as n from views where collection_id = ${collection.id}`
    const count = Number(countRows[0]?.n ?? 0)
    if (count >= MAX_VIEWS_PER_COLLECTION) {
      return {
        ok: false,
        message: `저장한 조건이 ${MAX_VIEWS_PER_COLLECTION}개예요. 안 쓰는 것을 지우고 다시 저장해 주세요 — 이만큼 쌓였다면 표를 나누는 편이 나을 수도 있어요.`,
      }
    }

    // slug: 라틴 문자가 안 남으면 view-N 순번 (계약 §1 ※ — MCP 도구명의 ASCII 제약)
    const base = suggestViewSlug(def.def.name) ?? `view-${count + 1}`
    const taken = await sql<{ slug: string }[]>`select slug from views where collection_id = ${collection.id}`
    const existing = new Set(taken.map((t) => t.slug))
    let slug = base
    for (let i = 2; existing.has(slug); i += 1) slug = `${base}-${i}`

    // 데모(로그인 전)에는 행위자가 없으니 컬렉션 주인 이름으로 남긴다
    const ownerId = actor.userId ?? collection.owner_id
    await sql`
      insert into views (collection_id, slug, name, where_json, sort_json, search_q, source_host, columns_json, owner_id, pinned)
      values (${collection.id}, ${slug}, ${def.def.name},
              ${JSON.stringify(def.def.where)}::jsonb, ${JSON.stringify(def.def.sort)}::jsonb,
              ${def.def.q}, ${def.def.source},
              ${def.def.columns === null ? null : JSON.stringify(def.def.columns)}::jsonb,
              ${ownerId}, ${def.def.pinned})
    `
    return { ok: true, slug }
  })
  return result.ok ? result.data : { ok: false, message: result.message }
}

/**
 * 기존 뷰를 지금 상태로 덮어쓴다. **slug 는 그대로** — 주소·AI 도구 이름이 안 끊긴다.
 * 이름을 주면 이름도 바꾼다. 알림 켬/끔·고정은 건드리지 않는다.
 */
export async function updateView(
  collection: ViewCollection,
  actor: Actor,
  slug: string,
  input: { name?: string; state: TableState },
): Promise<ViewWriteResult> {
  const guard = await requireManager(collection, actor)
  if (!guard.ok) return guard

  const result = await safeQuery(async (core): Promise<ViewWriteResult> => {
    const sql = core.queryClient
    // 이 컬렉션의 뷰인지 — 다른 컬렉션의 뷰 slug 를 넣어 고치는 길을 막는다
    const rows = await sql<{ id: string; name: string }[]>`
      select id, name from views where collection_id = ${collection.id} and slug = ${slug} limit 1
    `
    const row = rows[0]
    if (row === undefined) return { ok: false, message: '고치려는 조건을 찾지 못했어요. 이미 지워졌을 수 있어요.' }

    const name = input.name?.trim() || row.name
    const badName = nameProblem(name)
    if (badName !== null) return { ok: false, message: badName }

    const def = toDefinition({ name, state: input.state }, collection.schema_json, await hostsOf(core, collection.id))
    if (!def.ok) return def

    await sql`
      update views set name = ${def.def.name},
                       where_json = ${JSON.stringify(def.def.where)}::jsonb,
                       sort_json = ${JSON.stringify(def.def.sort)}::jsonb,
                       search_q = ${def.def.q},
                       source_host = ${def.def.source},
                       columns_json = ${def.def.columns === null ? null : JSON.stringify(def.def.columns)}::jsonb,
                       updated_at = now()
      where id = ${row.id} and collection_id = ${collection.id}
    `
    return { ok: true, slug }
  })
  return result.ok ? result.data : { ok: false, message: result.message }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 지우기·고정·이름·알림 — 전부 주인만, 전부 이 컬렉션의 뷰만 (collection_id 로 묶는다) */
async function guardedViewUpdate(
  collection: ViewCollection,
  actor: Actor,
  run: (sql: (typeof import('@endpointer/core/db'))['queryClient']) => Promise<number>,
  viewId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const guard = await requireManager(collection, actor)
  if (!guard.ok) return guard
  // 폼에서 온 값이다 — 모양부터 본다 (uuid 가 아니면 DB 오류를 "저장소 장애" 로 오해하게 된다)
  if (!UUID_RE.test(viewId)) return { ok: false, message: '그 조건을 찾지 못했어요. 화면을 새로 고쳐 주세요.' }
  const result = await safeQuery(async (core) => run(core.queryClient))
  if (!result.ok) return { ok: false, message: result.message }
  if (result.data === 0) return { ok: false, message: '그 조건을 찾지 못했어요. 화면을 새로 고쳐 주세요.' }
  return { ok: true }
}

export function deleteView(collection: ViewCollection, actor: Actor, viewId: string) {
  return guardedViewUpdate(collection, actor, async (sql) => {
    const r = await sql`delete from views where id = ${viewId}::uuid and collection_id = ${collection.id}`
    return r.count
  }, viewId)
}

export function setViewPinned(collection: ViewCollection, actor: Actor, viewId: string, pinned: boolean) {
  return guardedViewUpdate(collection, actor, async (sql) => {
    const r = await sql`
      update views set pinned = ${pinned}, updated_at = now() where id = ${viewId}::uuid and collection_id = ${collection.id}
    `
    return r.count
  }, viewId)
}

/** 이름만 바꾼다 — slug(주소·AI 도구 이름)는 그대로라 연결이 안 끊긴다 */
export function renameView(collection: ViewCollection, actor: Actor, viewId: string, name: string) {
  const bad = nameProblem(name)
  if (bad !== null) return Promise.resolve({ ok: false as const, message: bad })
  return guardedViewUpdate(collection, actor, async (sql) => {
    const r = await sql`
      update views set name = ${name.trim()}, updated_at = now() where id = ${viewId}::uuid and collection_id = ${collection.id}
    `
    return r.count
  }, viewId)
}

/** 알림 켬/끔. 어디로 갈지는 뷰가 아니라 컬렉션의 체크된 주소가 정한다 (07-30 개편) */
export function setViewNotify(collection: ViewCollection, actor: Actor, viewId: string, on: boolean) {
  const notify = on ? JSON.stringify({ on: 'enter' }) : null
  return guardedViewUpdate(collection, actor, async (sql) => {
    const r = await sql`
      update views set notify_json = ${notify}::jsonb, updated_at = now()
      where id = ${viewId}::uuid and collection_id = ${collection.id}
    `
    return r.count
  }, viewId)
}

// ── 사람 문장 — core 것을 그대로 쓴다 (MCP 도구 설명과 갈라지지 않게) ──────

export function summarizeView(view: Pick<ViewRecord, 'state'>, fields: readonly FieldDef[]): string {
  return summarizeViewState(view.state, fields)
}

/** 뷰 건강 → 사람 문장 (B2 — `warn`/`broken` 키를 그대로 내보내지 않는다) */
export function healthCopy(health: ViewHealth): { tone: 'ok' | 'healing' | 'attention'; text: string } {
  switch (health) {
    case 'ok':
      return { tone: 'ok', text: '정상' }
    case 'warn':
      return { tone: 'healing', text: '일부 사이트에만 조건이 적용돼요' }
    case 'broken':
      return { tone: 'attention', text: '표 구성이 바뀌어 지금은 쓸 수 없어요 — 알림도 멈춰 있어요' }
  }
}
