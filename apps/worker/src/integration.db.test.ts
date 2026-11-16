// 통합 시험 — 통제된 데모 데이터의 수집 → 저장 → 뷰 조건 판정 → 웹훅 전달 (ADR A50)
//
// ── 실제로 실행한 것 ──────────────────────────────────────────────────────
//  · 수집: runCollectJob — 실제 HTTP 로 **이 테스트가 띄운 로컬 목록 서버**(127.0.0.1)를 읽는다
//          (fetch 계층 · 해석기 · 정규화 · 드리프트 판정 · 항목 저장까지 실제 코드)
//  · 저장: 테스트 DB(endpointer_test)의 실제 SQL
//  · 판정: evaluateCollectionViews — 표·REST·MCP 와 같은 판정(parseStoredView · viewToQuery · buildItemsWhere)
//  · 전달: runDeliverJob — 실제 웹훅 채널이 **이 테스트가 띄운 로컬 수신 서버**로 POST 한다
// ── 대체한 경계 ────────────────────────────────────────────────────────────
//  · 큐(BullMQ·Redis): `./queues` 의 enqueue 함수를 가로채 받은 일감을 **같은 함수로 직접** 실행한다.
//    잡 사이의 다리만 바꿨고 잡 본체는 그대로다.
//  · 외부 사이트·LLM: 쓰지 않는다. 읽는 방법(스펙)은 사람이 적은 것(origin='human')을 넣는다.
//  · 사설 주소 차단: ALLOW_PRIVATE_HOSTS=true 로 로컬 서버만 열었다 (운영 기본값은 막힘).
//  · 채널 등록: 워커 기동(index.ts)이 하는 registerDeliverer 를 테스트가 같은 방식으로 한다.

import { createTestCollection, createTestUser, prepareTestDb, uniqueTag } from '@endpointer/core/testing'

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const status = await prepareTestDb()
process.env['ALLOW_PRIVATE_HOSTS'] = 'true'

// 큐 → 직접 실행 (머리말 "대체한 경계")
const queued = vi.hoisted(() => ({
  evaluate: [] as string[],
  deliver: [] as import('./queues').DeliverJobData[],
  heal: [] as unknown[],
}))
vi.mock('./queues', async (importOriginal) => {
  const real = await importOriginal<typeof import('./queues')>()
  return {
    ...real,
    enqueueEvaluate: async (collectionId: string) => {
      queued.evaluate.push(collectionId)
    },
    enqueueDeliver: async (data: import('./queues').DeliverJobData) => {
      queued.deliver.push(data)
    },
    enqueueHeal: async (data: unknown) => {
      queued.heal.push(data)
    },
  }
})

const { queryClient } = await import('@endpointer/core/db')
const { resetConfigCache } = await import('./config')
const { runCollectJob } = await import('./jobs/collect')
const { evaluateCollectionViews } = await import('./jobs/evaluate-views')
const { runDeliverJob } = await import('./jobs/deliver')
const { clearHttpCache } = await import('./fetchers')
const { registerDeliverer } = await import('./jobs/channels')
const { webhookDeliverer } = await import('./jobs/channels/webhook')

/** 목록 서버가 내놓는 항목 — 테스트가 회차마다 바꾼다 */
let listing: { id: string; title: string; amount: number; category: string; link: string }[] = []
const received: { body: Record<string, any>; headers: IncomingMessage['headers'] }[] = []

let listServer: Server
let hookServer: Server
let listUrl: string
let hookUrl: string

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
}

beforeAll(async () => {
  resetConfigCache()
  // 워커 기동(index.ts)이 하는 채널 등록과 같은 배선 — 웹훅 채널 본체는 실제 코드다
  registerDeliverer(webhookDeliverer)
  listServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ items: listing }))
  })
  hookServer = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      received.push({ body: JSON.parse(raw) as Record<string, any>, headers: req.headers })
      res.writeHead(200).end('ok')
    })
  })
  listUrl = `${await listen(listServer)}/list.json`
  hookUrl = `${await listen(hookServer)}/hook`
})

afterAll(async () => {
  await new Promise<void>((r) => (listServer ? listServer.close(() => r()) : r()))
  await new Promise<void>((r) => (hookServer ? hookServer.close(() => r()) : r()))
})

const FIELDS = [
  { key: 'title', label: '공고명', type: 'text', required: true, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money', required: false, mapping: null, value_labels: null },
  { key: 'category', label: '분야', type: 'enum', required: false, mapping: { 'R&D': 'rnd' }, value_labels: null },
  { key: 'link', label: '원문', type: 'link', required: false, mapping: null, value_labels: null },
] as const

describe.skipIf(!status.ok)('수집 → 저장 → 뷰 조건 판정 → 웹훅 전달', () => {
  let collectionId: string
  let sourceId: string
  let host: string
  let subscriptionId: string

  beforeAll(async () => {
    const owner = await createTestUser('통합 시험')
    const collection = await createTestCollection({ ownerId: owner, schema: [...FIELDS] })
    collectionId = collection.id
    host = '127.0.0.1'

    const srcRows = await queryClient<{ id: string }[]>`
      insert into sources (collection_id, host, entry_url, status, fetch_mode)
      values (${collectionId}, ${host}, ${listUrl}, 'ok', 'json') returning id
    `
    sourceId = srcRows[0]!.id
    const spec = {
      spec_version: 1,
      fetch: { mode: 'json', url: listUrl, method: 'GET', headers: {} },
      list: '$.items[*]',
      dedupe_key: '$.id',
      fields: {
        title: { path: '$.title', type: 'text' },
        amount: { path: '$.amount', type: 'money' },
        category: { path: '$.category', type: 'enum' },
        link: { path: '$.link', type: 'link' },
      },
      pagination: { kind: 'none' },
    }
    await queryClient`
      insert into adapters (source_id, version, spec_json, origin, status)
      values (${sourceId}, 1, ${JSON.stringify(spec)}::jsonb, 'human', 'active')
    `

    // 알림 켠 뷰 — 칸 조건 + 검색어 + 출처까지 (A47 의 새 조회 상태가 알림에도 같은 뜻인지)
    await queryClient`
      insert into views (collection_id, slug, name, where_json, sort_json, search_q, source_host, notify_json, owner_id)
      values (${collectionId}, 'big-youth', '큰 청년 R&D',
              ${JSON.stringify([{ field: 'amount', op: 'gte', value: 5000 }, { field: 'category', op: 'in', value: ['rnd'] }])}::jsonb,
              '[]'::jsonb, '청년', ${host}, ${JSON.stringify({ on: 'enter' })}::jsonb, ${owner})
    `
    // 알림 켠 **깨진** 뷰 — 사라진 칸 조건. 빼고 평가하면 전부 매칭돼 알림이 쏟아진다 (고친 버그)
    await queryClient`
      insert into views (collection_id, slug, name, where_json, notify_json, owner_id)
      values (${collectionId}, 'broken', '깨진 조건',
              ${JSON.stringify([{ field: 'budget', op: 'gte', value: 1 }])}::jsonb, ${JSON.stringify({ on: 'enter' })}::jsonb, ${owner})
    `
    const subRows = await queryClient<{ id: string }[]>`
      insert into subscriptions (collection_id, user_id, channel, target, name, enabled)
      values (${collectionId}, ${owner}, 'webhook', ${hookUrl}, '테스트 수신', true) returning id
    `
    subscriptionId = subRows[0]!.id
  })

  async function cycle() {
    queued.evaluate.length = 0
    queued.deliver.length = 0
    clearHttpCache()
    const collected = await runCollectJob({ source_id: sourceId, collection_id: collectionId, host, reason: 'manual' })
    // 큐 다리 — 수집이 넣은 평가 요청을 그대로 실행
    expect(queued.evaluate).toEqual([collectionId])
    const evaluated = await evaluateCollectionViews(collectionId)
    for (const job of [...queued.deliver]) {
      const delivered = await runDeliverJob(job)
      expect(delivered.outcome).toBe('sent')
    }
    return { collected, evaluated }
  }

  it('1회차: 조건에 맞는 항목만 웹훅으로 간다 · 깨진 뷰는 평가하지 않는다', async () => {
    const tag = uniqueTag('it')
    listing = [
      { id: `${tag}-1`, title: '청년 연구 지원', amount: 10_000, category: 'rnd', link: 'https://x/1' }, // 맞음
      { id: `${tag}-2`, title: '청년 소액', amount: 1_000, category: 'rnd', link: 'https://x/2' }, // 금액 미달
      { id: `${tag}-3`, title: '일반 연구 지원', amount: 20_000, category: 'rnd', link: 'https://x/3' }, // 검색어 없음
      { id: `${tag}-4`, title: '청년 창업', amount: 30_000, category: 'startup', link: 'https://x/4' }, // 분야 다름
      { id: `${tag}-5`, title: '청년 대형 연구', amount: 50_000, category: 'R&D', link: 'https://x/5' }, // 맞음 (원문 표기 → 정규화)
    ]
    const before = received.length
    const { collected, evaluated } = await cycle()

    expect(collected).toMatchObject({ ran: true, items_found: 5, items_new: 5 })
    const stored = await queryClient<{ n: number }[]>`select count(*)::int n from items where collection_id = ${collectionId}`
    expect(stored[0]?.n).toBe(5)

    const big = evaluated.find((e) => e.slug === 'big-youth')
    const broken = evaluated.find((e) => e.slug === 'broken')
    expect(big).toMatchObject({ matched: 2, notified: true })
    expect(big?.entered).toHaveLength(2)
    expect(broken).toMatchObject({ skipped: true, matched: 0, entered: [] })

    expect(queued.deliver).toHaveLength(1)
    expect(queued.deliver[0]).toMatchObject({ subscription_id: subscriptionId, collection_id: collectionId })

    const hooks = received.slice(before)
    expect(hooks).toHaveLength(1)
    const links = (hooks[0]?.body.items as { _link: string }[]).map((i) => i._link).sort()
    expect(links).toEqual(['https://x/1', 'https://x/5'])
    expect(hooks[0]?.headers['content-type']).toContain('application/json')

    const deliveries = await queryClient<{ status: string; n: number }[]>`
      select status, cardinality(item_ids) as n from deliveries where subscription_id = ${subscriptionId}
    `
    expect(deliveries).toEqual([{ status: 'sent', n: 2 }])
  })

  it('2회차: 새로 조건에 들어온 항목만 다시 간다 (이미 보낸 것은 다시 보내지 않는다)', async () => {
    listing = [
      ...listing,
      { id: `${uniqueTag('it')}-6`, title: '청년 신규 연구', amount: 7_000, category: 'rnd', link: 'https://x/6' },
    ]
    const before = received.length
    const { collected, evaluated } = await cycle()
    expect(collected).toMatchObject({ items_new: 1 })
    expect(evaluated.find((e) => e.slug === 'big-youth')).toMatchObject({ matched: 3, entered: [expect.any(String)] })

    const hooks = received.slice(before)
    expect(hooks).toHaveLength(1)
    expect((hooks[0]?.body.items as { _link: string }[]).map((i) => i._link)).toEqual(['https://x/6'])
  })

  it('3회차: 바뀐 것이 없으면 아무것도 보내지 않는다', async () => {
    const before = received.length
    const { evaluated } = await cycle()
    expect(evaluated.find((e) => e.slug === 'big-youth')).toMatchObject({ entered: [], notified: false })
    expect(received.length).toBe(before)
  })
})
