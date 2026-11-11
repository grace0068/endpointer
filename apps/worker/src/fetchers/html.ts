// fetch.mode = 'html' · 'inline_json' — 정적 HTML 을 받는다 (기획서 11장 HTML 모드 · ADR A43)
//
// payload 는 HTML **문자열** 이다. 받는 방법이 둘에서 같기 때문에 이 함수 하나가 둘을 담당한다 —
// 다른 것은 "그 문자열을 어떻게 읽느냐" 이고 그건 core 해석기의 몫이다
// (html = CSS 경로, inline_json = script 안 JSON 을 꺼내 JSONPath).

import type { HtmlFetchSpec, InlineJsonFetchSpec } from '@endpointer/core/spec'

import { httpGet } from './http'
import type { PageFetchOutcome } from './types'

export async function fetchHtmlPayload(
  _fetchSpec: HtmlFetchSpec | InlineJsonFetchSpec,
  url: string,
): Promise<PageFetchOutcome> {
  const res = await httpGet(url, {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  })
  if (!res.ok) return { ok: false, message: res.message }

  const { response } = res
  if (!response.ok) {
    return { ok: false, message: `목록을 주지 않았습니다 (응답 ${response.status})` }
  }
  if (response.body.trim() === '') {
    return { ok: false, message: '빈 페이지를 받았습니다' }
  }

  return { ok: true, payload: response.body, finalUrl: response.url, cached: response.cached }
}
