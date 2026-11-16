// 접근 제어 · API 키 수명주기 (ADR A48·A49·A50) — 실제 DB · REST 라우트 핸들러 직접 호출.
//
// 실행한 것: 테스트 DB 의 실제 SQL, 권한 판정(lib/permissions), 키 관리(lib/api-keys), REST GET 핸들러.
// 대체한 것: 로그인(next-auth) — 행위자를 { userId, authReady } 로 직접 준다. 서버 액션은 이 함수들을
// currentActor() 로 부르는 얇은 껍데기라 같은 판정을 탄다.
// MCP 쪽 키 수명주기는 apps/mcp 의 mcp.db.test.ts 가 같은 순서로 본다.

import {
  addTestMember,
  createTestCollection,
  createTestSource,
  createTestUser,
  insertTestItems,
  prepareTestDb,
  type TestCollection,
} from '@endpointer/core/testing'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/v1/[collection]/route'
import type { PublicApiBody } from '@/lib/public-api'
import { getApiKeyStatus, issueApiKey, revokeApiKey } from '@/lib/api-keys'
import { getCollectionBySlug, updateCollectionVisibility } from '@/lib/collections'
import { setCollectionListed } from '@/lib/gallery'
import { requireManager, resolveAccessFor, type Actor } from '@/lib/permissions'

const status = await prepareTestDb()

const FIELDS = [
  { key: 'title', label: '공고명', type: 'text' as const, required: true, mapping: null, value_labels: null },
  { key: 'amount', label: '지원금', type: 'money' as const, required: false, mapping: null, value_labels: null },
]

async function rest(slug: string, headers: Record<string, string> = {}, qs = '') {
  const res = await GET(new Request(`http://test.local/api/v1/${slug}?${qs}`, { headers }), {
    params: Promise.resolve({ collection: slug }),
  })
  return { status: res.status, body: (await res.json()) as PublicApiBody, raw: res }
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

describe.skipIf(!status.ok)('화면 접근 — 주인 · 멤버 · 외부인 · 비로그인 (공개 범위와 무관)', () => {
  let owner: string
  let member: string
  let outsider: string
  const collections: Record<string, TestCollection> = {}

  beforeAll(async () => {
    owner = await createTestUser('주인')
    member = await createTestUser('멤버')
    outsider = await createTestUser('외부인')
    for (const visibility of ['private', 'unlisted', 'public'] as const) {
      const c = await createTestCollection({ ownerId: owner, schema: FIELDS, visibility })
      await addTestMember(c.id, member)
      collections[visibility] = c
    }
  })

  const actor = (userId: string | null): Actor => ({ userId, authReady: true })

  for (const visibility of ['private', 'unlisted', 'public'] as const) {
    it(`${visibility}: 주인은 보고 바꾸고, 멤버는 보기만, 외부인·비로그인은 아무것도`, async () => {
      const c = collections[visibility] as TestCollection
      expect(await resolveAccessFor(c, actor(owner))).toMatchObject({ canView: true, canManage: true })
      expect(await resolveAccessFor(c, actor(member))).toMatchObject({ canView: true, canManage: false })
      expect(await resolveAccessFor(c, actor(outsider))).toMatchObject({ canView: false, canManage: false })
      expect(await resolveAccessFor(c, actor(null))).toMatchObject({ canView: false, canManage: false })
    })
  }

  it('바꾸는 요청의 관문 — 멤버는 "읽기 전용" 이라는 이유로, 외부인은 주인이 아니라는 이유로 거절', async () => {
    const c = collections['private'] as TestCollection
    const m = await requireManager(c, actor(member))
    const o = await requireManager(c, actor(outsider))
    expect(m.ok).toBe(false)
    expect(o.ok).toBe(false)
    if (!m.ok) expect(m.message).toContain('읽기 전용')
  })

  it('다른 컬렉션의 주인이어도 이 컬렉션은 못 바꾼다 (소속 확인)', async () => {
    const otherOwner = await createTestUser('다른 주인')
    await createTestCollection({ ownerId: otherOwner, schema: FIELDS })
    expect((await requireManager(collections['unlisted'] as TestCollection, actor(otherOwner))).ok).toBe(false)
  })
})

describe.skipIf(!status.ok)('REST 공개 범위 — 실제 판정이 설정 화면의 말과 같다', () => {
  it('public · unlisted 는 키 없이 200, private 은 키 없이 401', async () => {
    const owner = await createTestUser()
    for (const [visibility, expected] of [['public', 200], ['unlisted', 200], ['private', 401]] as const) {
      const c = await createTestCollection({ ownerId: owner, schema: FIELDS, visibility })
      const r = await rest(c.slug)
      expect(r.status).toBe(expected)
      if (expected === 401) expect(r.body.error?.code).toBe('unauthorized')
    }
  })

  it('없는 컬렉션은 404 — 모양은 그대로', async () => {
    const r = await rest('no-such-collection-xyz')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ items: [], error: { code: 'not_found' } })
  })

  it('공개에서 벗어나면 모두의 컬렉션 전시를 내린다 — 다시 공개해도 저절로 다시 올라가지 않는다', async () => {
    const owner = await createTestUser()
    const c = await createTestCollection({ ownerId: owner, schema: FIELDS, visibility: 'public' })
    expect((await setCollectionListed({ id: c.id, visibility: 'public' }, true)).ok).toBe(true)
    const r = await updateCollectionVisibility(c.id, 'unlisted')
    expect(r.ok && r.data.unlisted).toBe(true)
    await updateCollectionVisibility(c.id, 'public')
    const after = await getCollectionBySlug(c.slug)
    expect(after.ok && after.data?.listed).toBe(false)
  })

  it('공개가 아니면 전시할 수 없다', async () => {
    const owner = await createTestUser()
    const c = await createTestCollection({ ownerId: owner, schema: FIELDS, visibility: 'unlisted' })
    expect((await setCollectionListed({ id: c.id, visibility: 'unlisted' }, true)).ok).toBe(false)
  })
})

describe.skipIf(!status.ok)('API 키 수명주기 — 발급 · 교체 · 폐기 후 REST 접근', () => {
  let owner: string
  let member: string
  let c: TestCollection

  beforeAll(async () => {
    owner = await createTestUser('주인')
    member = await createTestUser('멤버')
    c = await createTestCollection({ ownerId: owner, schema: FIELDS, visibility: 'private' })
    const s = await createTestSource(c.id, 'k.example')
    await insertTestItems(c.id, s, [{ data: { title: '비공개 항목', amount: 1 } }])
    await addTestMember(c.id, member)
  })

  afterEach(() => vi.restoreAllMocks())

  const ownerActor = (): Actor => ({ userId: owner, authReady: true })

  it('키가 아직 없으면 어떤 키로도 401', async () => {
    expect((await rest(c.slug, bearer('ep_guess'))).status).toBe(401)
  })

  it('멤버·외부인은 키를 만들거나 없앨 수 없다 — DB 도 그대로', async () => {
    expect((await issueApiKey(c, { userId: member, authReady: true })).ok).toBe(false)
    expect((await issueApiKey(c, { userId: null, authReady: true })).ok).toBe(false)
    expect((await revokeApiKey(c, { userId: member, authReady: true })).ok).toBe(false)
    const st = await getApiKeyStatus(c.id)
    expect(st.ok && st.data.active).toBe(false)
  })

  it('발급 → 그 키로 200 · 교체 → 옛 키 401 · 새 키 200 · 폐기 → 401', async () => {
    const logs: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
    }

    const first = await issueApiKey(c, ownerActor())
    if (!first.ok) throw new Error(first.message)
    expect(first.key).toMatch(/^ep_[A-Za-z0-9_-]{43}$/)
    expect(first.replaced).toBe(false)
    const ok1 = await rest(c.slug, bearer(first.key))
    expect(ok1.status).toBe(200)
    expect(ok1.body.items).toHaveLength(1)

    // 저장된 것은 해시·앞 글자뿐 — 원문은 DB 에도 없다
    const st = await getApiKeyStatus(c.id)
    expect(st.ok && st.data).toMatchObject({ active: true, hint: first.key.slice(0, 7) })

    const second = await issueApiKey(c, ownerActor())
    if (!second.ok) throw new Error(second.message)
    expect(second.replaced).toBe(true)
    expect((await rest(c.slug, bearer(first.key))).status).toBe(401)
    expect((await rest(c.slug, bearer(second.key))).status).toBe(200)

    expect((await revokeApiKey(c, ownerActor())).ok).toBe(true)
    const gone = await rest(c.slug, bearer(second.key))
    expect(gone.status).toBe(401)
    expect(gone.body.error?.code).toBe('unauthorized')

    // 원문 키는 어떤 로그에도, 어떤 응답 본문에도 없다
    for (const key of [first.key, second.key]) {
      expect(logs.some((l) => l.includes(key))).toBe(false)
      expect(JSON.stringify(gone.body)).not.toContain(key)
    }
  })

  it('REST 는 주소의 ?key= 를 받지 않는다 — 키는 헤더로만 (A48)', async () => {
    const issued = await issueApiKey(c, ownerActor())
    if (!issued.ok) throw new Error(issued.message)
    expect((await rest(c.slug, {}, `key=${issued.key}`)).status).toBe(401)
    expect((await rest(c.slug, bearer(issued.key))).status).toBe(200)
  })

  it('비공개를 공개로 바꾸면 키 없이도 열린다 — 공개 범위가 키보다 먼저다 (화면이 그렇게 말한다)', async () => {
    const owner2 = await createTestUser()
    const c2 = await createTestCollection({ ownerId: owner2, schema: FIELDS, visibility: 'private' })
    expect((await rest(c2.slug)).status).toBe(401)
    await updateCollectionVisibility(c2.id, 'unlisted')
    expect((await rest(c2.slug)).status).toBe(200)
  })
})

describe.skipIf(!status.ok)('REST 오류 정책 — 적용할 수 없는 조건은 더 넓은 결과 대신 실패', () => {
  let c: TestCollection

  beforeAll(async () => {
    const owner = await createTestUser()
    c = await createTestCollection({ ownerId: owner, schema: FIELDS })
    const s = await createTestSource(c.id, 'e.example')
    await insertTestItems(c.id, s, Array.from({ length: 12 }, (_, i) => ({ data: { title: `t${i}`, amount: i } })))
  })

  const cases: [string, number, string][] = [
    ['titel=a', 400, 'invalid_query'],
    ['amount=많이', 400, 'invalid_query'],
    ['title_gte=a', 400, 'invalid_query'],
    ['sort=ghost', 400, 'invalid_query'],
    ['limit=201', 400, 'limit_exceeded'],
    ['cursor=abc', 400, 'invalid_cursor'],
    ['view=nope', 404, 'view_not_found'],
    ['view=a&view=b', 400, 'invalid_query'],
  ]
  for (const [qs, code, errorCode] of cases) {
    it(`${qs} → ${code} ${errorCode}`, async () => {
      const r = await rest(c.slug, {}, qs)
      expect(r.status).toBe(code)
      expect(r.body.error?.code).toBe(errorCode)
      expect(r.body.items).toEqual([])
      expect(r.body.error?.message).not.toMatch(/\b(400|404|422)\b/)
    })
  }

  it('정렬을 바꾸고 옛 커서를 보내면 400 invalid_cursor', async () => {
    const first = await rest(c.slug, {}, 'sort=amount&limit=5')
    const next = first.body.page.next_cursor as string
    const r = await rest(c.slug, {}, `sort=-amount&limit=5&cursor=${next}`)
    expect(r.status).toBe(400)
    expect(r.body.error?.code).toBe('invalid_cursor')
  })

  it('문제 목록이 함께 온다 — 무엇을 고쳐야 하는지', async () => {
    const r = await rest(c.slug, {}, 'titel=a&limit=999')
    expect(r.body.error?.problems?.map((p) => p.param).sort()).toEqual(['limit', 'titel'])
  })
})
