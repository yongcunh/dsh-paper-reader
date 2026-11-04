/**
 * 用 CDP 打开 DSH 页面、点开「论文」悬浮按钮并截图（开发自测用）。
 * 用法: node tools/cdp-shot.mjs <url> <out.png>
 */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const url = process.argv[2]
const out = process.argv[3] || 'shot.png'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = 9333

const chrome = spawn(CHROME, [
  '--headless=old', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=/tmp/pr-cdp-profile', '--window-size=1500,1000',
  `--remote-debugging-port=${port}`, 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function getJson (path) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`)
      return await r.json()
    } catch { await sleep(250) }
  }
  throw new Error('chrome not ready')
}

const targets = await getJson('/json/list')
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const logs = []
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 600))
  if (msg.method === 'Runtime.consoleAPICalled') logs.push('LOG ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 600))
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
await new Promise(r => { ws.onopen = r })

function send (method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}

await send('Page.enable')
await send('Log.enable')
ws.addEventListener('message', (ev) => {})

await send('Runtime.enable')
await send('Page.navigate', { url })
await sleep(9000)

await send('Runtime.evaluate', {
  expression: `(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '继续');
    if (b) b.click();
  })()`
})
await sleep(800)
const clicked = await send('Runtime.evaluate', {
  expression: `(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => (x.textContent || '').includes('论文'));
    if (b) { b.click(); return 'clicked:' + b.textContent.trim(); }
    return 'not-found:' + btns.length;
  })()`,
  returnByValue: true
})
console.log(clicked.result?.result?.value)
console.log(logs.join('\n'))

await sleep(6000)
const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(out, Buffer.from(shot.result.data, 'base64'))
console.log('saved', out)

ws.close()
chrome.kill()
