// MCP 서버 기동 — 앱은 app.ts 가 만들고 여기는 listen 만 한다 (테스트가 같은 앱을 임의 포트로 띄운다)
//
// 포트는 MCP_PORT (기본 3002). 배포에서는 Caddy 가 mcp.example.com/* 을 여기로 붙인다.

// **이 줄이 맨 위에 있어야 한다.** .env 는 레포 루트에 있고, 아래 `@endpointer/core/db` 는
// 모듈을 읽는 순간 DATABASE_URL 을 요구한다. 자세한 이유는 load-env.ts 머리말에.
import './load-env'

import { pino } from 'pino'

import { closeDb, db, getEnv } from '@endpointer/core/db'

import { createApp } from './app'

const env = getEnv()

const log = pino({
  name: 'endpointer-mcp',
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
})

/**
 * 컨테이너 밖에서 들어와야 하므로 모든 인터페이스에 붙는다.
 * 대신 Host 헤더 화이트리스트로 DNS 리바인딩을 막는다 (아래 allowedHosts).
 */
const BIND_HOST = '0.0.0.0'

/** 공개 주소의 호스트명 + 로컬. 포트는 미들웨어가 알아서 무시한다 */
function allowedHostnames(): string[] {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  try {
    hosts.add(new URL(env.PUBLIC_MCP_BASE_URL).hostname)
  } catch {
    log.warn('PUBLIC_MCP_BASE_URL 을 주소로 읽지 못해 로컬 주소만 허용합니다')
  }
  return [...hosts]
}

const app = createApp({ db, log, allowedHosts: allowedHostnames(), bindHost: BIND_HOST })

const listener = app.listen(env.MCP_PORT, BIND_HOST, () => {
  log.info(
    { port: env.MCP_PORT, publicBaseUrl: env.PUBLIC_MCP_BASE_URL },
    'MCP 서버가 떴습니다 (컬렉션 주소: {공개주소}/{slug})',
  )
})

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, '종료합니다')
  listener.close()
  await closeDb().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

export { app }
