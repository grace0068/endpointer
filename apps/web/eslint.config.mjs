// web lint 설정 — ESLint 9 flat config (ADR A51). 이 파일이 없어서 `pnpm lint` 가 아예 돌지 않았다.
// Next 공식 규칙(core-web-vitals) + TypeScript 규칙을 그대로 쓴다. 규칙을 덜어내지 않는다 —
// 걸리는 것은 코드를 고치고, 정말로 의도한 예외만 이유와 함께 연다.
import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

const config = [
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // `_` 로 시작하는 이름은 "일부러 안 쓴다" 는 저장소 관례다. 서버 액션은 useActionState 가
      // (prev, formData) 를 넘기므로 안 쓰는 매개변수도 자리를 지켜야 한다
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  { ignores: ['.next/**', 'next-env.d.ts', 'node_modules/**'] },
]

export default config
