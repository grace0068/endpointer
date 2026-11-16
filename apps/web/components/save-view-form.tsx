'use client'

import { useActionState, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useActionToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'

export interface SaveViewState {
  status: 'idle' | 'problem'
  message: string | null
}

const SAVE_IDLE: SaveViewState = { status: 'idle', message: null }

type SaveAction = (prev: SaveViewState, formData: FormData) => Promise<SaveViewState>

/**
 * "지금 보는 것 저장" (델타 2-10 · A47). 결과를 보면서 정의하므로 빈 뷰를 만들 일이 없다.
 *  - create: 새 뷰로 저장. 이름은 조건에서 자동 제안되고 사용자는 고치기만 한다 (B3 와 같은 정신)
 *  - update: 고치던 뷰에 덮어쓰기. **주소·AI 도구 이름(slug)은 그대로** 라고 말해 준다
 * `stateJson` 은 서버가 만든 지금 상태 — 검색어·출처·정렬·열까지 전부 들어 있다.
 */
export function SaveViewForm({
  stateJson,
  suggestedName,
  create,
  update,
}: {
  stateJson: string
  suggestedName: string
  create: SaveAction
  /** 고치는 중인 뷰가 있으면 그 뷰에 덮어쓰기 */
  update?: { viewSlug: string; viewName: string; save: SaveAction }
}) {
  const [createState, createAction, creating] = useActionState(create, SAVE_IDLE)
  const [updateState, updateAction, updating] = useActionState(update?.save ?? create, SAVE_IDLE)
  const [name, setName] = useState(suggestedName)
  useActionToast(createState)
  useActionToast(updateState)

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-accent-line bg-accent-soft px-4 py-3">
      {update !== undefined && (
        <form action={updateAction} className="flex items-center gap-2">
          <input type="hidden" name="state" value={stateJson} />
          <input type="hidden" name="view_slug" value={update.viewSlug} />
          <Button type="submit" size="sm" disabled={updating}>
            {updating ? '저장하는 중…' : `‘${update.viewName}’에 덮어쓰기`}
          </Button>
          <span className="text-xs text-muted">주소와 AI 도구 이름은 그대로예요</span>
        </form>
      )}
      <form action={createAction} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="state" value={stateJson} />
        <label htmlFor="save-view-name" className="sr-only">
          저장할 이름
        </label>
        <input
          id="save-view-name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          className={cn(
            'h-9 min-w-0 flex-1 rounded-lg border-[1.5px] border-accent-line bg-surface px-3',
            'text-[13px] font-semibold text-ink focus:border-accent focus:outline-none',
          )}
        />
        <Button type="submit" size="sm" variant={update !== undefined ? 'outline' : 'primary'} disabled={creating}>
          {creating ? '저장하는 중…' : update !== undefined ? '새 조건으로 저장' : '이 조건 저장'}
        </Button>
      </form>
    </div>
  )
}
