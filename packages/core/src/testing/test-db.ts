// 테스트 전용 데이터베이스 (ADR A50)
//
// ── 규칙 셋 ──────────────────────────────────────────────────────────────
//  1. **개발 DB(`endpointer`)를 절대 건드리지 않는다.** 같은 Postgres 서버의 `endpointer_test` 만 쓴다.
//     이름이 `_test` 로 끝나지 않으면 거부한다 — 개발 DB 에는 사용자의 실데이터가 있다.
//  2. **못 돌린 테스트를 통과로 세지 않는다.** DB 에 닿지 못하면 이유를 출력하고 건너뛴다(skip).
//     `REQUIRE_DB_TESTS=1` 이면 건너뛰지 않고 실패한다 (CI 용).
//  3. **이 모듈은 앱의 DB 클라이언트보다 먼저 import 돼야 한다.** `@endpointer/core/db` 는 모듈을
//     읽는 순간 DATABASE_URL 로 연결 풀을 만든다(A29 와 같은 함정). 그래서 여기가 모듈 최상단에서
//     DATABASE_URL 을 테스트 DB 로 바꿔 둔다. 테스트 파일의 **첫 import** 로 이 모듈을 둔다.
//
// 데이터 격리는 "테스트마다 새 컬렉션" 으로 한다 — 모든 조회가 collection_id 로 묶이므로
// 표를 비우지 않아도 테스트끼리 섞이지 않고, vitest 가 파일을 병렬로 돌려도 안전하다.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../..')
const MIGRATIONS_DIR = path.resolve(HERE, '../../drizzle')

loadDotenv({ path: path.join(REPO_ROOT, '.env'), quiet: true })

/** 테스트 DB 주소를 정한다. 개발 DB 주소에서 DB 이름만 `<이름>_test` 로 바꾼다 */
function resolveTestUrl(): { ok: true; url: string; dbName: string } | { ok: false; reason: string } {
  const explicit = process.env['TEST_DATABASE_URL']?.trim()
  const devUrl = process.env['DATABASE_URL']?.trim()
  const raw = explicit !== undefined && explicit !== '' ? explicit : devUrl
  if (raw === undefined || raw === '') {
    return { ok: false, reason: 'DATABASE_URL·TEST_DATABASE_URL 이 둘 다 없다 (.env 확인)' }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'DB 주소를 읽지 못했다' }
  }
  const current = url.pathname.replace(/^\//, '')
  if (explicit === undefined || explicit === '') {
    // 이미 테스트 DB 를 가리키고 있으면(다른 테스트 파일이 먼저 바꿔 둔 경우) 그대로 쓴다
    url.pathname = `/${current.endsWith('_test') ? current : `${current}_test`}`
  }
  const dbName = url.pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test')) {
    return { ok: false, reason: `테스트 DB 이름은 _test 로 끝나야 한다 (받은 이름: ${dbName}) — 개발 DB 보호` }
  }
  return { ok: true, url: url.toString(), dbName }
}

const resolved = resolveTestUrl()

// 규칙 3 — 앱 클라이언트가 읽기 전에 바꿔 둔다
if (resolved.ok) process.env['DATABASE_URL'] = resolved.url

export type TestDbStatus = { ok: true; url: string } | { ok: false; reason: string }

let preparing: Promise<TestDbStatus> | null = null

/** 마이그레이션이 동시에 두 번 돌지 않게 거는 잠금 번호 (아무 상수) */
const MIGRATION_LOCK = 4_710_046

async function prepare(): Promise<TestDbStatus> {
  if (!resolved.ok) return resolved
  const target = new URL(resolved.url)
  const adminUrl = new URL(resolved.url)
  adminUrl.pathname = '/postgres'

  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
  try {
    const exists = await admin`select 1 from pg_database where datname = ${resolved.dbName}`
    if (exists.length === 0) {
      try {
        await admin.unsafe(`create database "${resolved.dbName.replace(/"/g, '')}"`)
      } catch (cause) {
        // 다른 테스트 파일이 먼저 만들었다 (42P04 duplicate_database) — 괜찮다
        if ((cause as { code?: string }).code !== '42P04') throw cause
      }
    }
  } catch (cause) {
    return { ok: false, reason: `Postgres 에 닿지 못했다 (${target.host}): ${(cause as Error).message}` }
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {})
  }

  if (!existsSync(MIGRATIONS_DIR)) return { ok: false, reason: `마이그레이션 폴더가 없다: ${MIGRATIONS_DIR}` }

  // 같은 연결 하나에서 잠금 → 마이그레이션 → 해제 (max: 1)
  const client = postgres(resolved.url, { max: 1, connect_timeout: 3, onnotice: () => {} })
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR })
    await client`select pg_advisory_unlock(${MIGRATION_LOCK})`
  } catch (cause) {
    return { ok: false, reason: `테스트 DB 마이그레이션 실패: ${(cause as Error).message}` }
  } finally {
    await client.end({ timeout: 1 }).catch(() => {})
  }
  return { ok: true, url: resolved.url }
}

/**
 * 테스트 DB 를 준비한다 (없으면 만들고 마이그레이션). 프로세스(워커)당 한 번.
 * 실패해도 던지지 않는다 — 호출한 테스트가 `describe.skipIf(!status.ok)` 로 건너뛴다.
 * `REQUIRE_DB_TESTS=1` 이면 실패를 던진다.
 */
export function prepareTestDb(): Promise<TestDbStatus> {
  preparing ??= prepare().then((status) => {
    if (!status.ok) {
      if (process.env['REQUIRE_DB_TESTS'] === '1') {
        throw new Error(`DB 테스트를 돌릴 수 없다: ${status.reason}`)
      }
      // 건너뜀을 성공으로 오해하지 않게 눈에 띄게 남긴다 (A50)
      console.warn(`\n[DB 테스트 건너뜀] ${status.reason}\n`)
    }
    return status
  })
  return preparing
}

/** 테스트 DB 주소 (준비 전에도 계산된 값). 실패면 null */
export function testDatabaseUrl(): string | null {
  return resolved.ok ? resolved.url : null
}
