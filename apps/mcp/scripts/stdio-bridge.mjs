// 개발 도구 — stdio ↔ Streamable HTTP 다리. 메시지를 손대지 않고 양쪽으로 그대로 넘긴다.
//
// 언제 쓰나: MCP 클라이언트(예: WSL 안의 Claude Code)가 MCP 서버(Windows 의 localhost:3002)에
// 네트워크로 닿지 못할 때(WSL NAT · 방화벽). 다리를 **서버 쪽 Windows node** 로 띄우면 클라이언트는 stdio 로 붙는다.
//
//   claude mcp add <이름> -s local -- /mnt/c/WINDOWS/system32/cmd.exe /c node "C:\…\apps\mcp\scripts\stdio-bridge.mjs" http://localhost:3002/<slug>
//
// 비공개 컬렉션이면 환경변수 MCP_BRIDGE_AUTH="Bearer <API 키>" — 키를 주소(`?key=`)에 싣지 않는다 (A48).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const target = process.argv[2]
const headers = process.env.MCP_BRIDGE_AUTH ? { Authorization: process.env.MCP_BRIDGE_AUTH } : {}
const local = new StdioServerTransport()
const remote = new StreamableHTTPClientTransport(new URL(target), { requestInit: { headers } })

local.onmessage = (msg) => remote.send(msg).catch((e) => process.stderr.write(`[bridge] send: ${e}\n`))
remote.onmessage = (msg) => local.send(msg)
remote.onerror = (e) => process.stderr.write(`[bridge] remote: ${e}\n`)
local.onclose = () => remote.close().finally(() => process.exit(0))

await remote.start()
await local.start()
