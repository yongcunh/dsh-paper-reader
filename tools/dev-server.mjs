/**
 * 本地开发/预览用：用最小 ctx 跑宿主半侧路由（不依赖 DSH），
 * 模型调用用桩返回，便于验证 UI 与内容。
 * 用法: node tools/dev-server.mjs [port]
 */
import http from 'node:http'
import { apply } from '../lib/index.js'

const port = Number(process.argv[2] || 4173)
const routes = []

const ctx = {
  logger: console,
  effect: (fn) => { fn(); return () => {} },
  webServer: {
    register (route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } }
  },
  llm: {
    listProviders: () => [{ id: 'mock' }],
    stream: async function * ({ messages }) {
      const q = messages[messages.length - 1].content[0].text
      const answer = '（预览桩回答）关于「' + q.slice(-60) + '」：这里是开发模式下的占位回答，用于验证问答面板的显示与排版。公式示例：\\(\\alpha_r = \\langle X_r, R_r\\rangle/\\|R_r\\|_2^2\\)。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const ch of answer.match(/[\s\S]{1,12}/g) || []) yield { type: 'text-delta', index: 0, text: ch }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

apply(ctx)

function toRequest (req) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)
  const init = { method: req.method, headers: req.headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = req; init.duplex = 'half' }
  return new Request(url, init)
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname
    const route = routes.find(r => r.kind === 'prefix' ? path.startsWith(r.path) : path === r.path)
    if (!route) { res.writeHead(404).end('not found'); return }
    await route.handler(req, res)
  } catch (err) {
    console.error(err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(err))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log('paper-reader dev server: http://127.0.0.1:' + port + '/paper-reader/app')
})
