'use client'

// API 키 발급·교체·폐기 (ADR A48) — 연결 화면의 주인 전용 구역.
// 새 키는 만든 응답에서 **한 번만** 보인다. 서버에는 해시만 있어 다시 보여줄 수 없다.
// 화면을 떠나면 사라진다 — 주소·저장소(localStorage)·로그 어디에도 남기지 않는다.

import { useActionState } from 'react'

import type { KeyState } from '@/app/collections/[slug]/key-actions'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { useActionToast } from '@/components/ui/toast'

const IDLE: KeyState = { status: 'idle', message: null, key: null }

type KeyAction = (prev: KeyState, formData: FormData) => Promise<KeyState>

/** 화면이 그릴 마지막 상태 — 발급과 폐기를 한 줄로 이어서, 나중에 일어난 쪽이 이긴다 */
interface KeyView extends KeyState {
  /** 마지막으로 성공한 동작. 서버가 처음 그린 상태면 null */
  last: 'issued' | 'revoked' | null
}

const VIEW_IDLE: KeyView = { ...IDLE, last: null }

export function ApiKeyManage({
  active,
  hint,
  createdLabel,
  isPrivate,
  issue,
  revoke,
}: {
  active: boolean
  hint: string | null
  createdLabel: string | null
  isPrivate: boolean
  issue: KeyAction
  revoke: KeyAction
}) {
  // 발급·폐기를 **하나의** 액션 상태로 받는다 — 두 상태를 effect 로 맞추면 렌더가 한 번 더 돈다
  const [view, dispatch, pending] = useActionState<KeyView, FormData>(async (prev, formData) => {
    const op = formData.get('op')
    const result = op === 'revoke' ? await revoke(prev, formData) : await issue(prev, formData)
    if (result.status !== 'done') return { ...result, key: prev.key, last: prev.last }
    return { ...result, last: op === 'revoke' ? 'revoked' : 'issued' }
  }, VIEW_IDLE)
  useActionToast(view)

  const fresh = view.last === 'issued' ? view.key : null
  const hasKey = view.last === 'issued' || (view.last === null && active)

  return (
    <section className="rounded-card border border-border bg-surface p-7">
      <h2 className="mb-1 text-base font-bold text-ink">API 키</h2>
      <p className="mb-4 text-[13px] leading-relaxed text-faint">
        {isPrivate
          ? '이 컬렉션은 비공개라 REST API 와 AI 연결이 이 키를 요구해요. 키는 요청 헤더(Authorization: Bearer …)에 넣어 보내요.'
          : '지금 공개범위에서는 키 없이도 열려요. 비공개로 바꾸면 이 키가 있어야 열려요 — 미리 만들어 둘 수 있어요.'}
      </p>

      {fresh !== null ? (
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[9px] border border-accent-line bg-accent-soft px-3.5 py-2.5 font-mono text-[12.5px] text-ink">
              {fresh}
            </code>
            <CopyButton value={fresh} label="복사" />
          </div>
          <p className="text-xs font-semibold text-attention">
            지금만 보여요. 이 화면을 떠나면 다시 볼 수 없어요 — 잃어버리면 새로 만들어야 해요.
          </p>
        </div>
      ) : hasKey ? (
        <p className="mb-3 text-[13px] text-muted">
          지금 쓰는 키: <code className="font-mono">{hint ?? 'ep_'}…</code>
          {createdLabel !== null ? ` (${createdLabel} 만듦)` : ''}. 키 내용은 만들 때만 보여요.
        </p>
      ) : (
        <p className="mb-3 text-[13px] text-muted">
          {isPrivate ? '아직 키가 없어서 API·AI 연결로는 아무도 이 컬렉션을 열 수 없어요.' : '아직 키가 없어요.'}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <form action={dispatch}>
          <input type="hidden" name="op" value="issue" />
          <Button type="submit" size="sm" disabled={pending}>
            {hasKey ? '새 키로 바꾸기' : '키 만들기'}
          </Button>
        </form>
        {hasKey && (
          <form action={dispatch}>
            <input type="hidden" name="op" value="revoke" />
            <Button type="submit" size="sm" variant="outline" disabled={pending}>
              키 없애기
            </Button>
          </form>
        )}
      </div>
      {hasKey && (
        <p className="mt-2 text-xs text-faint">
          새 키로 바꾸거나 없애면 지금 키는 그 순간부터 REST API 와 AI 연결 모두에서 쓸 수 없어요.
        </p>
      )}
    </section>
  )
}
