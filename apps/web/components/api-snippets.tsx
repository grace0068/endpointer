'use client'

// 개발자용 — API 를 코드로 바로 붙일 수 있게 (연결 탭).
//
// 왜 JSON 만이 아니라 여러 형식인가: REST API 를 처음 붙일 때 개발자가 실제로 복사하는 건
// 대개 "바로 실행되는" 것이다 — cURL 로 응답을 확인하고, fetch/requests 로 코드에 심는다.
// 응답 JSON 은 "받는 것"이라 형태를 눈으로 보려는 용도 → 실제 응답 샘플을 지어내지 않고 보여준다.

import { useState } from 'react'

import { CopyButton } from '@/components/copy-button'
import { cn } from '@/lib/utils'

type Format = 'cURL' | 'JavaScript' | 'Python' | 'JSON 응답'

const BASE_FORMATS: Format[] = ['cURL', 'JavaScript', 'Python']

/**
 * 키는 **헤더로만** 보낸다 (ADR A48) — 주소에 실으면 프록시·접근 로그·기록에 남는다.
 * 예시에는 실제 키 대신 환경 변수 이름을 쓴다. 키는 위 "API 키" 카드에서 한 번만 보인다.
 * 다음 페이지는 응답의 page.next_cursor 를 cursor 로 다시 보내면 된다 — 조건은 그대로 두고.
 */
function buildSnippet(format: Format, apiUrl: string, sampleJson: string | null, requiresKey: boolean): string {
  switch (format) {
    case 'cURL':
      return requiresKey
        ? `curl -H "Authorization: Bearer $ENDPOINTER_API_KEY" "${apiUrl}?limit=20"`
        : `curl "${apiUrl}?limit=20"`
    case 'JavaScript':
      return [
        requiresKey
          ? `const headers = { Authorization: \`Bearer \${process.env.ENDPOINTER_API_KEY}\` }`
          : `const headers = {}`,
        `const res = await fetch("${apiUrl}?limit=20", { headers })`,
        `const { items, sources, page, error } = await res.json()`,
        `// 더 있으면: ?limit=20&cursor=\${page.next_cursor} (조건·정렬은 그대로)`,
      ].join('\n')
    case 'Python':
      return [
        `import os, requests`,
        ``,
        requiresKey
          ? `headers = {"Authorization": f"Bearer {os.environ['ENDPOINTER_API_KEY']}"}`
          : `headers = {}`,
        `r = requests.get("${apiUrl}", params={"limit": 20}, headers=headers)`,
        `data = r.json()  # 실패면 r.status_code 와 data["error"]["code"]`,
      ].join('\n')
    case 'JSON 응답':
      return sampleJson ?? ''
  }
}

export function ApiSnippets({
  apiUrl,
  sampleJson,
  requiresKey = false,
}: {
  apiUrl: string
  sampleJson: string | null
  /** 비공개 컬렉션이면 예시가 Authorization 헤더를 싣는다 */
  requiresKey?: boolean
}) {
  // 응답 샘플이 있을 때만 그 탭을 보인다 (빈 컬렉션이면 보여줄 응답이 없다)
  const formats: Format[] = sampleJson !== null ? [...BASE_FORMATS, 'JSON 응답'] : BASE_FORMATS
  const [format, setFormat] = useState<Format>('cURL')
  const snippet = buildSnippet(format, apiUrl, sampleJson, requiresKey)

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted">코드로 붙이기</span>

      <div className="flex flex-wrap gap-1">
        {formats.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFormat(f)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
              format === f
                ? 'bg-[oklch(0.24_0.008_277)] text-white'
                : 'bg-raised text-muted hover:text-ink',
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="relative">
        <pre className="scroll-x rounded-lg bg-[oklch(0.2_0.008_277)] px-4 py-3.5 font-mono text-xs leading-relaxed text-[oklch(0.89_0.005_277)]">
          {snippet}
        </pre>
        <div className="absolute top-2 right-2">
          <CopyButton value={snippet} label="복사" />
        </div>
      </div>

      {format === 'JSON 응답' && (
        <p className="text-xs text-faint">
          실제 응답의 일부예요. <code className="font-mono">items</code> 는 항목 배열,{' '}
          <code className="font-mono">sources</code> 는 사이트별 상태 — 하나가 아파도 나머지는 정상
          응답이에요.
        </p>
      )}
    </div>
  )
}
