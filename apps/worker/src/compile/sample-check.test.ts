// 표본 대조 (ADR A45) — 실측 실패(링커리어)를 그대로 옮긴 픽스처로 본다
import type { AdapterSpec } from '@endpointer/core/spec'
import { AdapterSpecSchema } from '@endpointer/core/spec'
import { describe, expect, it } from 'vitest'

import { checkPathsAgainstSample } from './sample-check'

/** 링커리어 activityItems 의 실제 모양 — 키는 셋뿐이다 */
const ROWS = [
  { url: 'https://linkareer.com/activity/1', name: '공고 가', imageUrl: 'https://x/1' },
  { url: 'https://linkareer.com/activity/2', name: '공고 나', imageUrl: 'https://x/2' },
  { url: 'https://linkareer.com/activity/3', name: '공고 다', imageUrl: 'https://x/3' },
]
const KEYS = ['imageUrl', 'name', 'url']

function inlineSpec(fields: Record<string, { path: string; type: string }>, dedupe?: string): AdapterSpec {
  return AdapterSpecSchema.parse({
    spec_version: 1,
    fetch: {
      mode: 'inline_json',
      url: 'https://linkareer.com/list/activity',
      script: { kind: 'id', id: '__NEXT_DATA__' },
    },
    list: '$.props.pageProps.activityItems[*]',
    ...(dedupe !== undefined ? { dedupe_key: dedupe } : {}),
    fields,
  })
}

describe('checkPathsAgainstSample — 실측 실패를 잡는다', () => {
  it('실패한 판(지어낸 $.title · $.id)은 거절하고 실제 키를 알려준다', () => {
    const spec = inlineSpec(
      {
        title: { path: '$.title', type: 'text' },
        link: { path: '$.id', type: 'link' },
        organization: { path: '$.organizationName', type: 'text' },
      },
      '$.id',
    )
    const errors = checkPathsAgainstSample(spec, ROWS, KEYS)
    const joined = errors.join(' ')
    expect(errors.length).toBeGreaterThan(0)
    expect(joined).toContain("'$.title'")
    expect(joined).toContain("'$.id'")
    expect(joined).toContain('dedupe_key')
    // 다음 판이 고칠 수 있게 — 실제로 있는 키 목록
    expect(joined).toContain("'name'")
    expect(joined).toContain("'url'")
  })

  it('성공한 판($.name · $.url)은 통과한다 — 선택 칸이 비어 있어도', () => {
    const spec = inlineSpec(
      {
        title: { path: '$.name', type: 'text' },
        link: { path: '$.url', type: 'link' },
        organization: { path: '$.organizationName', type: 'text' }, // 비어도 repair-empty 몫
        deadline: { path: '$.dDay', type: 'date' },
      },
      '$.url',
    )
    expect(checkPathsAgainstSample(spec, ROWS, KEYS)).toEqual([])
  })
})

describe('checkPathsAgainstSample — 거절 기준', () => {
  it('title 만 살아 있으면 통과 (link 가 비어도 이름으로 알아볼 수 있다)', () => {
    const spec = inlineSpec({ title: { path: '$.name', type: 'text' }, link: { path: '$.nope', type: 'link' } })
    expect(checkPathsAgainstSample(spec, ROWS, KEYS)).toEqual([])
  })

  it('link 만 살아 있어도 통과 — 단 title 이 죽어 있으면 거절', () => {
    const titleDead = inlineSpec({ title: { path: '$.nope', type: 'text' }, link: { path: '$.url', type: 'link' } })
    expect(checkPathsAgainstSample(titleDead, ROWS, KEYS).length).toBeGreaterThan(0)
  })

  it('title 칸이 없고 link 칸이 전부 죽으면 거절', () => {
    const spec = inlineSpec({ name: { path: '$.name', type: 'text' }, link: { path: '$.nope', type: 'link' } })
    expect(checkPathsAgainstSample(spec, ROWS, KEYS).length).toBeGreaterThan(0)
  })

  it('알아볼 칸이 아예 없는 스키마는 판단하지 않는다', () => {
    const spec = inlineSpec({ memo: { path: '$.nope', type: 'text' } })
    expect(checkPathsAgainstSample(spec, ROWS, KEYS)).toEqual([])
  })

  it('일부 행에서만 값이 나와도 산 경로다', () => {
    const rows = [{ name: '가' }, { other: 1 }, { other: 2 }]
    const spec = inlineSpec({ title: { path: '$.name', type: 'text' } })
    expect(checkPathsAgainstSample(spec, rows, ['name', 'other'])).toEqual([])
  })
})

describe('checkPathsAgainstSample — 판단하지 않는 경우', () => {
  it('CSS 모드는 보지 않는다 (표본이 행 글자라 경로를 대 볼 수 없다)', () => {
    const spec = AdapterSpecSchema.parse({
      spec_version: 1,
      fetch: { mode: 'html', url: 'https://example.com/list' },
      list: 'css:ul > li',
      fields: { title: { path: 'css:.nope', type: 'text' } },
    })
    expect(checkPathsAgainstSample(spec, ['행 글자'], [])).toEqual([])
  })

  it('표본이 비어 있으면 판단하지 않는다', () => {
    const spec = inlineSpec({ title: { path: '$.title', type: 'text' } })
    expect(checkPathsAgainstSample(spec, [], [])).toEqual([])
  })

  it('json 모드에도 같은 검사가 걸린다 (inline_json 전용이 아니다)', () => {
    const spec = AdapterSpecSchema.parse({
      spec_version: 1,
      fetch: { mode: 'json', url: 'https://example.com/api' },
      list: '$.items[*]',
      fields: { title: { path: '$.title', type: 'text' } },
    })
    expect(checkPathsAgainstSample(spec, ROWS, KEYS).length).toBeGreaterThan(0)
  })
})
