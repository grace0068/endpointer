// 인라인 JSON 추출 — 페이지 안 `<script>` 에서 목록 데이터를 꺼낸다 (ADR A43)
//
// ── 이 파일이 지키는 선 ─────────────────────────────────────────────────
// **파서는 `JSON.parse` 하나다.** 스펙이 적는 것은 "어느 스크립트인가"(`ScriptLocator`) 뿐이고,
// 벗기는 방법은 여기 고정된 알고리즘이다. 스펙에서 벗기기 규칙을 조립할 수 있게 열면
// 그것이 곧 표현식 평가의 앞문이고, 원칙 ②("어댑터에 코드를 실행시키지 않는다")가 무너진다.
//
// 그래서 `window.__NUXT__=(function(a,b){…})(…)` 같은 형태는 **못 읽고, 읽으려 하지도 않는다.**
// 그 사이트는 probe 3단계(네트워크 관찰)나 browser 모드가 받는다.
//
// ── 스크립트 목록을 직접 긁지 않는 이유 ─────────────────────────────────
// `HtmlAdapter.scripts()` 로 주입받는다 (A43 ④ · A18 의 방식). core 가 문자열 스캐너를
// 따로 구현하면 파서가 둘이 되고, probe 가 매긴 순번과 수집 시점의 순번이 어긋날 수 있다.

import type { HtmlAdapter, InlineScript } from './paths'
import type { ScriptLocator } from './spec'

/** 추출 결과. 실패 사유는 **사람이 읽는 문장**이다 (보장선 B4 — 화면 경고로 그대로 나간다) */
export type InlineJsonResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string }

/**
 * locator 가 가리키는 스크립트에서 JSON 을 꺼낸다.
 *
 * @param html  받아온 페이지 HTML
 * @param adapter `scripts()` 를 제공하는 주입점
 */
export function extractInlineJson(html: string, locator: ScriptLocator, adapter: HtmlAdapter): InlineJsonResult {
  let scripts: InlineScript[]
  try {
    scripts = adapter.scripts(html)
  } catch {
    return { ok: false, reason: '페이지 내용을 읽지 못했습니다' }
  }
  if (scripts.length === 0) {
    return { ok: false, reason: '페이지 안에서 데이터를 담은 부분을 찾지 못했습니다' }
  }

  switch (locator.kind) {
    case 'id': {
      const found = scripts.find((s) => s.id === locator.id)
      if (found === undefined) {
        return { ok: false, reason: `페이지 안에서 '${locator.id}' 부분을 찾지 못했습니다` }
      }
      const data =
        locator.format === 'devalue' ? resolveDevaluePayload(found.content) : tryParse(found.content)
      if (data === undefined) {
        return { ok: false, reason: `'${locator.id}' 부분의 내용을 읽지 못했습니다` }
      }
      return { ok: true, data: unwrapFetchedBody(data) ?? data }
    }

    case 'global': {
      for (const script of scripts) {
        const data = extractAssignedObject(script.content, locator.name)
        if (data !== undefined) return { ok: true, data }
      }
      return { ok: false, reason: `페이지 안에서 '${locator.name}' 값을 읽지 못했습니다` }
    }

    case 'ld_json': {
      // 순번이 아니라 **내용**으로 찾는다 — 스크립트가 하나 늘어도 밀리지 않는다 (A43 ①)
      for (const script of scripts) {
        if (!(script.type ?? '').toLowerCase().includes('ld+json')) continue
        const data = tryParse(script.content)
        if (data !== undefined && hasItemList(data)) return { ok: true, data }
      }
      return { ok: false, reason: '페이지 안에서 목록 정보를 찾지 못했습니다' }
    }

    case 'json_script': {
      const candidates = scripts.filter((s) => {
        const type = (s.type ?? '').toLowerCase()
        return s.id === null && (type.includes('application/json') || type === 'json')
      })
      const found = candidates[locator.index]
      if (found === undefined) {
        return { ok: false, reason: '페이지 안에서 데이터를 담은 부분을 찾지 못했습니다' }
      }
      const data = tryParse(found.content)
      if (data === undefined) {
        return { ok: false, reason: '페이지 안의 데이터를 읽지 못했습니다' }
      }
      return { ok: true, data: unwrapFetchedBody(data) ?? data }
    }
  }
}

// ── JSON 파싱 (유일한 파서) ────────────────────────────────────────────

export function tryParse(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * SvelteKit 이 심는 fetch 응답 캐시 — `{status, statusText, headers, body}` 에서
 * body(JSON 문자열)를 꺼내 파싱한다. 그 모양이 아니면 null (그대로 쓰라는 뜻).
 */
export function unwrapFetchedBody(data: unknown): unknown | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>
  if (typeof obj['status'] !== 'number' || typeof obj['body'] !== 'string') return null
  const inner = tryParse(obj['body'])
  return inner === undefined ? null : inner
}

// ── 전역 대입 (`window.X = {…};`) ──────────────────────────────────────

/**
 * `window.__NUXT__ = { … }` 처럼 대입된 객체 리터럴을 꺼낸다.
 *
 * 알고리즘은 이것이 전부다: 이름 → 첫 `=` → 괄호 짝이 맞는 조각 → `JSON.parse`.
 * Nuxt 3 의 `window.__NUXT__=(function(a,b){…})(…)` 처럼 JSON 이 아닌 것은 포기한다 —
 * 그 경우 네트워크 관찰(probe 3단계)이 잡아준다. **여기서 코드를 실행할 생각은 하지 않는다** (원칙 ②).
 */
export function extractAssignedObject(source: string, name: string): unknown | undefined {
  const idx = source.indexOf(name)
  if (idx < 0) return undefined

  const eq = source.indexOf('=', idx + name.length)
  if (eq < 0) return undefined

  let i = eq + 1
  while (i < source.length && /\s/.test(source[i] ?? '')) i += 1
  const open = source[i]
  if (open !== '{' && open !== '[') return undefined

  const end = matchBracket(source, i)
  if (end < 0) return undefined

  return tryParse(source.slice(i, end + 1))
}

/** 문자열 리터럴과 이스케이프를 건너뛰며 짝이 되는 괄호를 찾는다 */
function matchBracket(source: string, start: number): number {
  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let quote: string | null = null

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

// ── devalue (Nuxt 3 `__NUXT_DATA__`) ──────────────────────────────────

/**
 * devalue 배열을 일반 객체로 되돌린다.
 *
 * 형식: 모든 값이 한 배열에 눕고, 객체의 값·배열의 원소 자리에는 그 배열의 **인덱스**가 온다.
 * 루트는 인덱스 0. 배열 원소는 전부 숫자(인덱스)이므로, 첫 원소가 문자열인 배열은
 * `["Date", …]` 같은 타입 래퍼다 — Date 는 문자열 그대로 살린다 (날짜 파서가 먹는다).
 * 음수 인덱스는 undefined·NaN 류의 특수값 표기다. 순환·깊이는 방어한다.
 */
export function resolveDevaluePayload(content: string): unknown | undefined {
  const arr = tryParse(content)
  if (!Array.isArray(arr) || arr.length === 0) return undefined

  const resolving = new Set<number>()

  const resolve = (index: unknown, depth: number): unknown => {
    if (typeof index !== 'number' || !Number.isInteger(index)) return undefined
    if (index < 0 || index >= arr.length) return undefined
    if (depth > 16 || resolving.has(index)) return undefined

    const entry: unknown = arr[index]
    if (entry === null || typeof entry !== 'object') return entry

    resolving.add(index)
    try {
      if (Array.isArray(entry)) {
        if (entry.length > 0 && typeof entry[0] === 'string') {
          // 타입 래퍼. 목록 스캔에 의미 있는 것만 살리고 나머지는 버린다
          if (entry[0] === 'Date' && typeof entry[1] === 'string') return entry[1]
          if (entry[0] === 'Set') return entry.slice(1).map((i) => resolve(i, depth + 1))
          return undefined
        }
        return entry.map((i) => resolve(i, depth + 1))
      }
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(entry)) {
        out[key] = resolve(value, depth + 1)
      }
      return out
    } finally {
      resolving.delete(index)
    }
  }

  return resolve(0, 0)
}

// ── ld+json 에 ItemList 가 있는가 ──────────────────────────────────────

/**
 * `@type` 에 `ItemList` 가 든 노드가 있는지. 객체 하나·배열·`@graph` 중첩을 다 본다.
 * `ld_json` locator 가 순번 대신 이걸로 그릇을 고른다 (A43 ①).
 */
export function hasItemList(data: unknown): boolean {
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 4) return false
    if (Array.isArray(node)) return node.some((child) => walk(child, depth + 1))
    if (node === null || typeof node !== 'object') return false
    const obj = node as Record<string, unknown>
    const type = obj['@type']
    if (typeof type === 'string' && type.includes('ItemList')) return true
    if (Array.isArray(type) && type.some((t) => typeof t === 'string' && t.includes('ItemList'))) return true
    return walk(obj['@graph'], depth + 1)
  }
  return walk(data, 0)
}
