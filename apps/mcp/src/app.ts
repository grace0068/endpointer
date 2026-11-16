// MCP Streamable HTTP 앱 — 기획서 12장
//
//   POST|GET|DELETE  /{slug}     컬렉션 하나가 곧 MCP 서버 하나
//   GET              /healthz
//
// 앱 만들기와 listen 을 나눈 이유 (ADR A50): 테스트가 **실제 HTTP 서버**를 임의 포트로 띄워
// 공식 SDK 클라이언트로 부를 수 있어야 한다. listen 은 index.ts 만 한다.
//
// ── 세션을 두지 않는다 (stateless) ───────────────────────────────────────
// `sessionIdGenerator: undefined` 로 두고 **요청마다 McpServer + transport 를 새로 만든다.**
// 근거 세 가지:
//   1. 이 서버의 도구는 전부 읽기 전용이다. 요청 사이에 이어갈 상태가 없다.
//   2. 세션을 두면 메모리에 transport 맵이 생기고, 프로세스를 재시작하거나 인스턴스를
//      늘리는 순간 클라이언트가 404 를 받는다.
//   3. 도구 목록이 **컬렉션 스키마·저장된 뷰에서 생성**된다. 바뀌면 다음 요청부터 자동으로
//      새 도구 목록이 나간다 — 세션에 서버 인스턴스를 캐싱하면 낡은 도구가 살아남는다.

import { randomUUID } from 'node:crypto'

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Express, NextFunction, Request, Response } from 'express'
import type { Logger } from 'pino'

import type { Db } from '@endpointer/core/db'
import type { ApiErrorResponse } from '@endpointer/core'
import type { StoredView } from '@endpointer/core/query'

import { KEY_QUERY_PARAM, presentedKeyFrom, resolveCollectionAccess } from './auth'
import { instructionsFor, registerCollectionTools, registerViewTools } from './tools'
import { loadViewsForMcp } from './views'

export const SERVER_VERSION = '0.1.0'

export interface CreateAppOptions {
  db: Db
  log: Logger
  /** Host 헤더 화이트리스트 (DNS 리바인딩 방어) */
  allowedHosts: string[]
  /** 컨테이너 밖에서 들어와야 하면 0.0.0.0 */
  bindHost?: string
  /** 상대 날짜 기준 시각 — 테스트가 고정한다 */
  now?: () => Date
}

function fail(res: Response, status: number, body: ApiErrorResponse): void {
  res.status(status).json(body)
}

export function createApp(opts: CreateAppOptions): Express {
  const { db, log } = opts
  const app = createMcpExpressApp({ host: opts.bindHost ?? '0.0.0.0', allowedHosts: opts.allowedHosts })
  app.disable('x-powered-by')

  // `/:slug` 보다 먼저 선언해야 컬렉션으로 오인되지 않는다
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'mcp', version: SERVER_VERSION })
  })

  app.all('/:slug', async (req: Request, res: Response) => {
    const slug = String(req.params['slug'] ?? '')

    const presented = presentedKeyFrom({
      authorization: req.headers.authorization,
      queryKey: req.query[KEY_QUERY_PARAM] as string | string[] | undefined,
    })

    const grant = await resolveCollectionAccess(db, slug, presented.key)
    if (!grant.ok) {
      // 키 자체는 절대 로그에 남기지 않는다. 어느 경로로 제시됐는지만 남긴다 (A48)
      log.info({ slug, code: grant.code, keyChannel: presented.channel }, '접근 거절')
      fail(res, grant.code === 'not_found' ? 404 : 401, { error: { message: grant.message, code: grant.code } })
      return
    }
    if (presented.channel === 'query') {
      // 폐기 예정 경로의 실제 사용량 — 0 이 되면 제거 ADR 을 쓴다
      log.info({ slug: grant.collection.slug }, '주소에 실린 키로 접속 (폐기 예정 경로)')
    }

    const collection = grant.collection

    // 저장된 뷰 → 도구. 뷰를 못 읽어도 고정 도구 4개는 살아야 하므로 실패는 빈 목록으로 낮춘다
    let views: StoredView[] = []
    try {
      views = await loadViewsForMcp(db, collection.id, collection.schema_json)
    } catch (cause) {
      log.warn({ slug: collection.slug, err: cause }, '저장된 뷰를 읽지 못해 고정 도구만 낸다')
    }

    const server = new McpServer(
      { name: `endpointer/${collection.slug}`, title: collection.name, version: SERVER_VERSION },
      { instructions: instructionsFor(collection, views.map((v) => v.name)) },
    )
    const ctx = { db, collection, ...(opts.now !== undefined ? { now: opts.now } : {}) }
    registerCollectionTools(server, ctx)
    registerViewTools(server, ctx, views)

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

    // 요청이 끝나면 둘 다 닫는다. 이게 없으면 stateless 인데도 객체가 쌓인다
    res.on('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  // 컬렉션 주소가 아닌 곳 — 사람이 브라우저로 열었을 때 포함. 질의 문자열은 남기지 않는다
  app.use((req: Request, res: Response) => {
    log.debug({ path: req.path }, '알 수 없는 주소')
    fail(res, 404, { error: { message: '그런 주소의 컬렉션을 찾지 못했습니다.', code: 'not_found' } })
  })

  // 마지막 그물. 스택 트레이스를 응답에 절대 싣지 않는다 (보장선 B4)
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const traceId = randomUUID()
    log.error({ err, traceId }, '요청 처리 중 오류')
    if (res.headersSent) {
      next(err)
      return
    }
    fail(res, 503, {
      error: { message: '지금은 응답을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', code: 'unavailable' },
    })
  })

  return app
}
