// MCP — 실제 HTTP 서버 + 공식 SDK 클라이언트 (ADR A46·A48·A50)
//
// 실행한 것: 테스트 DB 의 실제 SQL, createApp() 으로 만든 실제 Express 앱을 임의 포트로 listen,
// @modelcontextprotocol/sdk 의 Client + StreamableHTTPClientTransport 로 initialize → tools/list → tools/call.
// 대체한 것: 없음 (기준 시각만 createApp 의 now 로 고정).
// 비교 대상: core/testing 의 기준 데이터 기대값 — 웹 표·REST 테스트(apps/web/test)가 같은 기대값과 비교한다.

import { REFERENCE_NOW, prepareTestDb, seedReference, type ReferenceSeed } from '@endpointer/core/testing'

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Writable } from 'node:stream'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, queryClient } from '@endpointer/core/db'
import { generateApiKey } from '@endpointer/core/auth'
import { runCollectionRequest } from '@endpointer/core/query'

import { createApp } from './app'

const status = await prepareTestDb()

/** 서버 로그를 모은다 — 키가 새는지 본다 */
const logLines: string[] = []
const sink = new Writable({
  write(chunk, _enc, done) {
    logLines.push(String(chunk))
    done()
  },
})

let server: Server
let base: string

async function connect(slug: string, opts: { key?: string; queryKey?: string } = {}): Promise<Client> {
  const url = new URL(`${base}/${slug}${opts.queryKey ? `?key=${encodeURIComponent(opts.queryKey)}` : ''}`)
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: opts.key ? { Authorization: `Bearer ${opts.key}` } : {} },
  })
  const client = new Client({ name: 'endpointer-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

type ToolOut = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text?: string }[] }

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolOut
}

/** 커서를 끝까지 따라가 링크를 모은다 */
async function walk(client: Client, name: string, args: Record<string, unknown>): Promise<string[]> {
  const links: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 100; guard += 1) {
    const out = await call(client, name, { ...args, ...(cursor ? { cursor } : {}) })
    if (out.isError) throw new Error(JSON.stringify(out.structuredContent))
    const body = out.structuredContent as { items: { _link: string }[]; page: { next_cursor: string | null } }
    links.push(...body.items.map((i) => i._link))
    cursor = body.page.next_cursor
    if (cursor === null) break
  }
  return links
}

beforeAll(async () => {
  if (!status.ok) return
  const app = createApp({
    db,
    log: pino({ level: 'info' }, sink),
    allowedHosts: ['127.0.0.1', 'localhost'],
    bindHost: '127.0.0.1',
    now: () => REFERENCE_NOW,
  })
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
})

describe.skipIf(!status.ok)('MCP — 기준 데이터에서 웹 표·REST 와 같은 결과', () => {
  let ref: ReferenceSeed
  let client: Client

  beforeAll(async () => {
    ref = await seedReference()
    client = await connect(ref.collection.slug)
  })

  afterAll(async () => {
    await client?.close()
  })

  it('저장된 뷰가 도구로 나온다', async () => {
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_items', 'search_items', 'get_schema', 'get_sources_status', ref.viewSlug]))
    const viewTool = tools.tools.find((t) => t.name === ref.viewSlug)
    // 도구 설명에 검색어까지 들어간다 — 실제 조건보다 넓어 보이지 않게
    expect(viewTool?.description).toContain('청년')
  })

  it('뷰 도구를 커서로 2개씩 끝까지 — 기대값과 같다', async () => {
    expect(await walk(client, ref.viewSlug, { limit: 2 })).toEqual(ref.expectedView)
  })

  it('list_items 같은 임시 조건을 9개씩 — 기대값과 같다 (200개 경계 너머까지 누락·중복 없음)', async () => {
    expect(await walk(client, 'list_items', { source: ref.hostB, sort: '-amount', limit: 9 })).toEqual(ref.expectedAdhoc)
  })

  it('search_items 도 같은 검색 경로 — 전체 컬렉션 대상', async () => {
    const out = await call(client, 'search_items', { query: '공고 23', limit: 50 })
    const links = (out.structuredContent?.items as { _link: string }[]).map((i) => i._link).sort()
    expect(links).toEqual(ref.rows.filter((r) => r.title.includes('공고 23')).map((r) => r.link).sort())
  })

  // 같은 입력이면 REST 와 같은 판단·같은 원인 — REST 는 core 의 같은 함수 결과를 그대로 본문에 싣는다
  const ERROR_CASES: [string, Record<string, unknown>, string, string][] = [
    ['모르는 칸(오타)', { titel: 'a' }, 'titel=a', 'invalid_query'],
    ['값 형식', { amount: '많이' }, 'amount=많이', 'invalid_query'],
    ['상한 초과', { limit: 201 }, 'limit=201', 'limit_exceeded'],
    ['깨진 커서', { cursor: 'abc' }, 'cursor=abc', 'invalid_cursor'],
    ['정렬 기준', { sort: 'ghost' }, 'sort=ghost', 'invalid_query'],
  ]
  for (const [label, args, qs, code] of ERROR_CASES) {
    it(`오류 일치 — ${label}: MCP 와 REST(core) 가 같은 코드·같은 문장`, async () => {
      const out = await call(client, 'list_items', args)
      expect(out.isError).toBe(true)
      expect(out.structuredContent?.error.code).toBe(code)
      const restSide = await runCollectionRequest(db, ref.collection, { params: qs, now: REFERENCE_NOW })
      expect(restSide.ok).toBe(false)
      if (!restSide.ok) {
        expect(restSide.code).toBe(code)
        expect(out.structuredContent?.error.message).toBe(restSide.message)
      }
    })
  }

  it('뷰 도구에 다른 검색어를 얹으면 거절 — 뷰를 넓히지 않는다', async () => {
    const out = await call(client, ref.viewSlug, { q: '창업' })
    expect(out.isError).toBe(true)
    expect(out.structuredContent?.error.code).toBe('invalid_query')
  })

  it('정렬을 바꾸고 옛 커서를 보내면 invalid_cursor', async () => {
    const first = await call(client, 'list_items', { sort: 'amount', limit: 3 })
    const cursor = first.structuredContent?.page.next_cursor as string
    const out = await call(client, 'list_items', { sort: '-amount', limit: 3, cursor })
    expect(out.structuredContent?.error.code).toBe('invalid_cursor')
  })

  it('표 구성이 바뀌어 깨진 뷰 도구는 view_unavailable + 원인', async () => {
    await queryClient`
      insert into views (collection_id, slug, name, where_json, owner_id)
      values (${ref.collection.id}, 'broken-one', '깨진 것', ${JSON.stringify([{ field: 'budget', op: 'gte', value: 1 }])}::jsonb, ${ref.ownerId})
    `
    const fresh = await connect(ref.collection.slug) // stateless — 다음 요청부터 도구가 생긴다
    const out = await call(fresh, 'broken-one', {})
    expect(out.isError).toBe(true)
    expect(out.structuredContent?.error.code).toBe('view_unavailable')
    expect(out.content[0]?.text).toContain('budget')
    await fresh.close()
  })
})

describe.skipIf(!status.ok)('MCP — API 키 수명주기 (REST 와 같은 판정 함수)', () => {
  it('비공개: 키 없이 401 → 키(헤더)로 연결 → 교체하면 옛 키 거절 → 폐기하면 전부 거절', async () => {
    const ref = await seedReference({ visibility: 'private' })
    const slug = ref.collection.slug

    await expect(connect(slug)).rejects.toThrow()

    const first = generateApiKey()
    await queryClient`update collections set api_key_hash = ${first.hash} where id = ${ref.collection.id}`
    const c1 = await connect(slug, { key: first.key })
    expect((await call(c1, 'list_items', { limit: 1 })).isError).toBeFalsy()
    await c1.close()

    const second = generateApiKey()
    await queryClient`update collections set api_key_hash = ${second.hash} where id = ${ref.collection.id}`
    await expect(connect(slug, { key: first.key })).rejects.toThrow()
    const c2 = await connect(slug, { key: second.key })
    await c2.close()

    // 폐기 예정 경로(?key=)도 같은 해시로 판정된다 — 교체되면 함께 무효
    await expect(connect(slug, { queryKey: first.key })).rejects.toThrow()
    const c3 = await connect(slug, { queryKey: second.key })
    await c3.close()

    await queryClient`update collections set api_key_hash = null where id = ${ref.collection.id}`
    await expect(connect(slug, { key: second.key })).rejects.toThrow()

    // 서버 로그에 원문 키가 없다 — 어느 경로로 왔는지만 남는다
    const joined = logLines.join('\n')
    for (const key of [first.key, second.key]) expect(joined).not.toContain(key)
    expect(joined).toContain('"keyChannel":"header"')
    expect(joined).toContain('폐기 예정 경로')
  })

  it('unlisted 는 키 없이 연결된다 — 주소가 곧 열쇠', async () => {
    const ref = await seedReference({ visibility: 'unlisted' })
    const c = await connect(ref.collection.slug)
    expect((await call(c, 'get_schema', {})).isError).toBeFalsy()
    await c.close()
  })

  it('없는 컬렉션은 연결되지 않는다', async () => {
    await expect(connect('no-such-collection')).rejects.toThrow()
  })
})
