// web 테스트 설정 — `@/` 별칭을 tsconfig 와 같게 맞춘다 (라우트 핸들러를 직접 부르는 테스트가 쓴다)
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { alias: { '@': root } },
  test: { environment: 'node' },
})
