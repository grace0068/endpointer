// 컴파일 직후 표본 대조 — 필드 경로가 표본에서 실제로 값을 내는가 (ADR A45)
//
// ── 왜 있나 ─────────────────────────────────────────────────────────────
// 검증(validateSpec)은 **모양**만 본다. `$.title` 은 문법상 완벽한 JSONPath 지만, 행에
// `title` 키가 없으면 값이 하나도 안 나온다. 실측(링커리어 7회 중 5회)에서 LLM 이 행에 없는
// 키(`$.title`·`$.id`)를 지어냈고, 이름·링크가 전부 비어 20행이 통째로 버려졌다.
//
// probe 는 이미 표본 행을 들고 있다. 그러니 **네트워크 없이** 경로를 대 볼 수 있다.
// 이건 추론이 아니라 탐색이다 — LLM 을 부르지 않는다 (A1).
//
// ── 무엇을 거절하나 ─────────────────────────────────────────────────────
// 항목을 알아볼 칸이 표본 **어디에서도** 값을 못 낼 때만 — `title` 칸이 있으면 title,
// 없으면 link 타입 칸 전부.
// 선택 칸(기관·마감 등)이 비는 것은 거절하지 않는다 — 그건 수집 후 `repair-empty` 가 걷어낸다.
// 거절할 때는 죽은 경로 전부와 **행에 실제로 있는 키**를 같이 말해 다음 판이 고칠 수 있게 한다.

import type { AdapterSpec } from '@endpointer/core/spec'
import { evaluateJsonPath, pathSyntaxFor } from '@endpointer/core/spec'

/** 대 볼 표본 행 수 상한 — probe 표본이 이 정도면 충분하고, 더 보면 느려지기만 한다 */
const MAX_SAMPLE_ROWS = 20

/** 경로 하나가 표본 몇 행에서 값을 냈는지 */
function hitCount(rows: readonly unknown[], path: string): number {
  let hits = 0
  for (const row of rows) {
    let values: unknown[]
    try {
      values = evaluateJsonPath(row, path)
    } catch {
      return 0 // 문법이 core 가 받지 않는 형태면 그 경로는 쓸 수 없다
    }
    if (values.some((v) => v !== null && v !== undefined && String(v).trim() !== '')) hits += 1
  }
  return hits
}

function isRecordRow(row: unknown): boolean {
  return typeof row === 'object' && row !== null && !Array.isArray(row)
}

/**
 * 스펙의 필드 경로를 probe 표본에 대 본다. 문제가 없으면 빈 배열,
 * 있으면 **재생성 프롬프트에 그대로 붙일 문장들**을 돌려준다.
 *
 * JSONPath 모드(json·inline_json)만 본다. CSS 모드의 표본은 행 글자라 경로를 대 볼 수 없다.
 *
 * @param rows probe 후보의 `rows` (JSONPath 모드면 항목 객체)
 * @param keys probe 후보의 `keys` — 행에 반복해서 나타나는 키
 */
export function checkPathsAgainstSample(
  spec: AdapterSpec,
  rows: readonly unknown[],
  keys: readonly string[],
): string[] {
  if (pathSyntaxFor(spec.fetch.mode) !== 'jsonpath') return []

  const sample = rows.filter(isRecordRow).slice(0, MAX_SAMPLE_ROWS)
  if (sample.length === 0) return [] // 대 볼 것이 없으면 판단하지 않는다

  const fields = Object.entries(spec.fields)
  const dead = new Set<string>()
  for (const [key, field] of fields) {
    if (hitCount(sample, field.path) === 0) dead.add(key)
  }

  // 항목을 알아볼 칸 (interpret.ts 의 신원 판정과 같은 순서):
  //   title 이 있으면 title 이 주인이다 — 살아 있으면 title 해시로 행이 산다. 죽었으면 지어낸 것이다.
  //   title 칸이 없으면 link 칸들이 대신한다 — 전부 죽으면 행이 "신원 없는 행"으로 버려진다.
  const hasTitle = spec.fields['title'] !== undefined
  const linkKeys = fields.filter(([, f]) => f.type === 'link').map(([k]) => k)
  const reject = hasTitle
    ? dead.has('title')
    : linkKeys.length > 0 && linkKeys.every((k) => dead.has(k))
  if (!reject) return []

  const keyList = keys.length > 0 ? keys.map((k) => `'${k}'`).join(', ') : '(표본에서 키를 읽지 못함)'
  const errors: string[] = []
  for (const [key, field] of fields) {
    if (!dead.has(key)) continue
    errors.push(
      `'${key}' 필드의 경로 '${field.path}' 가 표본 항목 ${sample.length}개 어디에서도 값을 내지 않았습니다. ` +
        '항목에 없는 키를 지어내지 마세요',
    )
  }
  if (spec.dedupe_key !== undefined && hitCount(sample, spec.dedupe_key) === 0) {
    errors.push(`'dedupe_key' 경로 '${spec.dedupe_key}' 도 표본에서 값을 내지 않았습니다. 안정적인 키가 없으면 넣지 마세요`)
  }
  errors.push(
    `항목 하나에 실제로 있는 키는 ${keyList} 입니다. 경로는 이 키들로만, 항목 하나를 기준으로 적으세요 (예: '$.${keys[0] ?? 'name'}')`,
  )
  return errors
}
