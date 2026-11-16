// 브라우저 시험 설정 (ADR A51) — `pnpm --filter @endpointer/web test:e2e`.
// `pnpm test` 에 섞이지 않게 *.e2e.ts 만 따로 돈다. 빌드한 앱을 띄우고 실제 브라우저로 누르므로 느리다.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { alias: { '@': root } },
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // 한 서버·한 브라우저를 순서대로 쓴다
    fileParallelism: false,
  },
})
