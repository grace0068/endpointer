// 사이트 붙이기 미리보기 — 워커 응답을 화면 상태로 옮기는 규칙 (기능 ② · 보장선 B1)
//
// 워커는 띄우지 않는다 — callWorker 를 가로채 워커가 실제로 보내는 모양(http/index.ts)을 돌려준다.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { reply } = vi.hoisted(() => ({ reply: { body: null as unknown } }))

vi.mock('./create', () => ({
  WORKER_UNAVAILABLE: '워커 없음',
  callWorker: async () => reply.body,
}))

const { attachPreviewViaWorker } = await import('./attach')

const MISSING = [
  { key: 'title', label: '공모전명' },
  { key: 'link', label: '원문링크' },
]

beforeEach(() => {
  reply.body = null
})

describe('attachPreviewViaWorker', () => {
  it('칸을 하나도 자동으로 못 맞춰도 물어볼 칸이 있으면 붙여넣기 화면으로 간다 (링커리어 실측)', async () => {
    reply.body = { ok: false, stage: 'match', message: '표의 칸을 이 사이트에서 자동으로 찾지 못했어요.', missing: MISSING }
    const r = await attachPreviewViaWorker({ slug: 's', url: 'https://linkareer.com/list/contest', pasted: {} })
    expect(r).toEqual({
      ok: true,
      data: {
        host: '',
        entryUrl: 'https://linkareer.com/list/contest',
        attached: [],
        missing: MISSING,
        pasted: [],
        rows: [],
        warnings: ['표의 칸을 이 사이트에서 자동으로 찾지 못했어요.'],
      },
    })
  })

  it('목록 자체를 못 찾았거나(probe) 물어볼 칸이 없으면 지금처럼 문장 하나', async () => {
    reply.body = { ok: false, stage: 'probe', message: '목록을 찾지 못했어요.', missing: [] }
    expect(await attachPreviewViaWorker({ slug: 's', url: 'https://x.example', pasted: {} })).toEqual({ ok: false, message: '목록을 찾지 못했어요.' })
    reply.body = { ok: false, stage: 'execute', message: '항목을 못 읽었어요.', missing: MISSING }
    expect(await attachPreviewViaWorker({ slug: 's', url: 'https://x.example', pasted: {} })).toEqual({ ok: false, message: '항목을 못 읽었어요.' })
  })

  it('워커가 없으면 그 문장', async () => {
    expect(await attachPreviewViaWorker({ slug: 's', url: 'https://x.example', pasted: {} })).toEqual({ ok: false, message: '워커 없음' })
  })
})
