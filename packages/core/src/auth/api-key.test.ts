// API 키 (ADR A48) — 발급·해시·판정. DB 없이 검증된다.
import { describe, expect, it } from 'vitest'

import {
  API_KEY_PREFIX,
  apiKeyMatches,
  bearerToken,
  decideApiAccess,
  generateApiKey,
  hashApiKey,
} from './api-key'

describe('generateApiKey', () => {
  it('ep_ + 256비트 난수(base64url 43자). 해시는 원문의 SHA-256, 힌트는 앞 7자', () => {
    const issued = generateApiKey()
    expect(issued.key).toMatch(/^ep_[A-Za-z0-9_-]{43}$/)
    expect(issued.hash).toBe(hashApiKey(issued.key))
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(issued.hint).toBe(issued.key.slice(0, 7))
    expect(issued.hint.startsWith(API_KEY_PREFIX)).toBe(true)
  })

  it('해시·힌트로는 원문을 되살릴 수 없다 — 해시에 원문이 들어 있지 않다', () => {
    const issued = generateApiKey()
    expect(issued.hash).not.toContain(issued.key.slice(3))
  })

  it('매번 다르다', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key))
    expect(keys.size).toBe(200)
  })
})

describe('apiKeyMatches', () => {
  const issued = generateApiKey()

  it('맞는 키만 통과', () => {
    expect(apiKeyMatches(issued.key, issued.hash)).toBe(true)
    expect(apiKeyMatches(issued.key, issued.hash.toUpperCase())).toBe(true)
    expect(apiKeyMatches(`${issued.key}x`, issued.hash)).toBe(false)
    expect(apiKeyMatches(generateApiKey().key, issued.hash)).toBe(false)
  })

  it('비었거나 해시가 망가졌으면 거절 (던지지 않는다)', () => {
    expect(apiKeyMatches(null, issued.hash)).toBe(false)
    expect(apiKeyMatches(issued.key, null)).toBe(false)
    expect(apiKeyMatches(issued.key, 'not-hex')).toBe(false)
    expect(apiKeyMatches(issued.key, 'abcd')).toBe(false)
  })
})

describe('bearerToken', () => {
  it('Bearer 스킴만', () => {
    expect(bearerToken('Bearer ep_abc')).toBe('ep_abc')
    expect(bearerToken('bearer   ep_abc ')).toBe('ep_abc')
    expect(bearerToken('Basic ep_abc')).toBeNull()
    expect(bearerToken(['Bearer a', 'Bearer b'])).toBe('a')
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken('Bearer ')).toBeNull()
  })
})

describe('decideApiAccess — REST·MCP 공통 판정', () => {
  const issued = generateApiKey()

  it('public · unlisted 는 키 없이 열린다', () => {
    expect(decideApiAccess({ visibility: 'public', api_key_hash: null }, null)).toEqual({ ok: true })
    expect(decideApiAccess({ visibility: 'unlisted', api_key_hash: issued.hash }, null)).toEqual({ ok: true })
  })

  it('private 는 지금 키만', () => {
    const c = { visibility: 'private' as const, api_key_hash: issued.hash }
    expect(decideApiAccess(c, issued.key)).toEqual({ ok: true })
    expect(decideApiAccess(c, null)).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(decideApiAccess(c, generateApiKey().key)).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  it('교체되면 옛 키는 즉시 무효 — 새 해시와 안 맞는다', () => {
    const rotated = generateApiKey()
    const c = { visibility: 'private' as const, api_key_hash: rotated.hash }
    expect(decideApiAccess(c, issued.key)).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(decideApiAccess(c, rotated.key)).toEqual({ ok: true })
  })

  it('폐기(해시 없음)면 어떤 키로도 못 연다', () => {
    const c = { visibility: 'private' as const, api_key_hash: null }
    expect(decideApiAccess(c, issued.key)).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  it('없는 컬렉션은 not_found', () => {
    expect(decideApiAccess(null, issued.key)).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('거절 문구에 키 원문·HTTP 코드가 없다 (B4)', () => {
    const r = decideApiAccess({ visibility: 'private', api_key_hash: issued.hash }, 'ep_wrongwrong')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).not.toContain('ep_wrongwrong')
      expect(r.message).not.toMatch(/401|403|unauthorized/i)
    }
  })
})
