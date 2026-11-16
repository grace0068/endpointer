// 브라우저 시험 공용 하네스 (ADR A51) — 빌드한 앱을 테스트 DB 에 붙여 띄우고 Chromium 을 연다.
// 빌드·DB·브라우저 중 하나라도 없으면 `ready=false` — 시험은 건너뜀으로 표시된다 (A50).

import { prepareTestDb, testDatabaseUrl } from '@endpointer/core/testing'

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface E2eEnv {
  ready: boolean
  browser: Browser | null
}

/** 준비 판정 — 테스트 파일이 모듈 최상단에서 한 번 부른다 */
export async function prepareE2e(): Promise<E2eEnv> {
  const hasBuild = existsSync(path.join(WEB_ROOT, '.next', 'BUILD_ID'))
  const status = await prepareTestDb()
  if (!hasBuild) {
    console.warn('\n[브라우저 시험 건너뜀] 빌드가 없다 — `pnpm --filter @endpointer/web test:e2e` 는 빌드부터 한다\n')
  }
  if (!status.ok || !hasBuild) return { ready: false, browser: null }
  try {
    return { ready: true, browser: await chromium.launch() }
  } catch (cause) {
    console.warn(`\n[브라우저 시험 건너뜀] Chromium 을 띄우지 못했다: ${(cause as Error).message}\n`)
    return { ready: false, browser: null }
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

export interface RunningApp {
  base: string
  stop: () => void
}

/** `next start` 를 테스트 DB 로 띄운다. extraEnv 로 워커 주소 같은 것을 바꿔 넣는다 */
export async function startApp(extraEnv: Record<string, string> = {}): Promise<RunningApp> {
  const port = await freePort()
  const nextBin = createRequire(path.join(WEB_ROOT, 'package.json')).resolve('next/dist/bin/next')
  const child: ChildProcess = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: WEB_ROOT,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() ?? '', ...extraEnv },
    stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(base)).status < 500) return { base, stop: () => child.kill() }
    } catch {
      // 아직 안 떴다
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  child.kill()
  throw new Error('웹 앱이 뜨지 않았다')
}

/** 둘러보기(투어) 장 이름 — components/tour/steps.ts 의 id 들 */
const TOUR_CHAPTERS = ['console', 'collection'] as const

/**
 * 새 브라우저 맥락. `tourSeen` 이면 둘러보기를 이미 본 사람으로 시작한다 —
 * 둘러보기는 화면을 덮으므로, 둘러보기 자체를 시험하는 곳이 아니면 이미 본 상태로 둔다.
 */
export async function newContext(browser: Browser, opts: { tourSeen: boolean }): Promise<BrowserContext> {
  const context = await browser.newContext()
  if (opts.tourSeen) {
    await context.addInitScript((chapters: readonly string[]) => {
      for (const id of chapters) localStorage.setItem(`ep:tour:${id}`, 'skipped')
    }, TOUR_CHAPTERS)
  }
  return context
}

/** 머리글 이름들 (보이는 순서) */
export async function headers(page: Page): Promise<string[]> {
  return (await page.locator('thead th').allInnerTexts()).map((t) => t.replace(/[↑↓]/g, '').trim())
}

/** 결과 범위 문장 — "전체 240개 중 1–50번째 · 뒤에 더 있어요" */
export async function range(page: Page): Promise<string> {
  return (await page.locator('p[aria-live="polite"]').innerText()).replace(/\s+/g, ' ').trim()
}
