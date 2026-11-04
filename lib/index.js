/**
 * dsh-paper-reader — 论文阅读框架（宿主半侧）
 *
 * 路由（前缀 /paper-reader）：
 *   app / assets            阅读器前端
 *   api/library             论文 + 分区
 *   api/collections         分区的增删改
 *   api/paper/<id>          元数据 / 改名 / 移动 / 删除
 *   api/upload              上传 PDF → 自动建论文并翻译
 *   api/ask                 调 ctx.llm 回答并落盘
 *
 * 内容目录（框架 / 内容分离）：
 *   content/collections.json          分区表（drafts 为固定默认分区）
 *   content/<id>/meta.json            元数据（collectionId、status、sections…）
 *   content/<id>/zh.html              中文正文
 *   content/<id>/paper.pdf            原文 PDF
 *   content/<id>/figures/             插图
 *   content/<id>/ingest.json          PDF 解析中间产物
 */
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, normalize, resolve, sep, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'

export const name = 'paper-reader'
export const inject = ['webServer', 'llm']

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT = join(ROOT, 'content')
const ASSETS = join(ROOT, 'assets')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const QA_DIR = join(DSH_HOME, 'paper-reader', 'qa')
const COLLECTIONS_FILE = join(CONTENT, 'collections.json')

const PREFIX = '/paper-reader'
const PLUGIN_VERSION = '0.2.1'
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/
const DRAFT = { id: 'drafts', name: 'Draft', fixed: true, order: 0 }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8'
}

/* ---------------- 基础工具 ---------------- */

function json (data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}
const fail = (message, status = 400) => json({ error: message }, status)

async function readJson (file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}
async function writeJson (file, data) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}
const ensureDir = (dir) => mkdir(dir, { recursive: true })

function safeJoin (root, rel) {
  const p = normalize(join(root, rel))
  if (p !== root && !p.startsWith(root + sep)) return null
  return p
}
function slug (s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'item'
}
async function serveFile (file, extraHeaders = {}) {
  try {
    const data = await readFile(file)
    return new Response(data, {
      headers: { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', ...extraHeaders }
    })
  } catch { return fail('not found', 404) }
}

/* ---------------- 分区 ---------------- */

async function listCollections () {
  let cols = await readJson(COLLECTIONS_FILE)
  if (!Array.isArray(cols) || !cols.length) {
    cols = [DRAFT, { id: 'quant', name: 'Quant Papers', order: 1 }, { id: 'llm', name: 'LLM Papers', order: 2 }]
    await writeJson(COLLECTIONS_FILE, cols)
  }
  if (!cols.some(c => c.id === DRAFT.id)) cols.unshift({ ...DRAFT })
  return cols.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
async function saveCollections (cols) { await writeJson(COLLECTIONS_FILE, cols) }

/* ---------------- 论文 ---------------- */

async function metaOf (id) {
  const meta = await readJson(join(CONTENT, id, 'meta.json'))
  if (!meta) return null
  if (!meta.collectionId) meta.collectionId = 'drafts'
  return meta
}

async function listPapers () {
  const cols = await listCollections()
  const byName = new Map(cols.map(c => [c.name, c.id]))
  const out = []
  let dirs = []
  try { dirs = await readdir(CONTENT, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const meta = await readJson(join(CONTENT, d.name, 'meta.json'))
    if (!meta) continue
    if (!meta.collectionId) meta.collectionId = byName.get(meta.collection) || 'drafts'
    out.push({ ...meta, id: d.name })
  }
  return out
}

/* ---------------- 上传与自动翻译 ---------------- */

const VENV_PY = join(ROOT, 'tools', '.venv', 'bin', 'python3')
const PY_DEPS_LIST = ['pypdf', 'pillow', 'pdfplumber']
let pyReadyPromise = null

function bundledPy () {
  if (process.env.DSH_PYTHON) return process.env.DSH_PYTHON
  const cand = join(homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3')
  return existsSync(cand) ? cand : 'python3'
}

async function ensurePyDeps (ctx) {
  if (pyReadyPromise) return pyReadyPromise
  pyReadyPromise = (async () => {
    if (existsSync(VENV_PY)) {
      try { await run(VENV_PY, ['-c', 'import pypdf, PIL, pdfplumber']); return true } catch (e) { /* recreate */ }
    }
    // 优先用系统 python 建 venv（不受宿主签名限制，能装原生轮子）
    try {
      const candidates = [
        process.env.DSH_SYSTEM_PYTHON,
        '/usr/bin/python3',
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        'python3'
      ].filter(Boolean)
      let hostPy = null
      for (const c of candidates) {
        try { await run(c, ['-c', 'import sys; print(sys.version_info[0])']); hostPy = c; break } catch (e) {}
      }
      if (!hostPy) throw new Error('找不到系统 python3，请设置 DSH_SYSTEM_PYTHON')
      if (ctx) await jobLogSafe(ctx, 'info', '首次运行：正在准备 Python 依赖（pypdf / pillow / pdfplumber）…')
      await run(hostPy, ['-m', 'venv', join(ROOT, 'tools', '.venv')])
      await run(VENV_PY, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check'].concat(PY_DEPS_LIST))
      return true
    } catch (e) {
      console.warn('[paper-reader] venv setup failed:', e.message)
    }
    // 回退：宿主自带 python（可能缺少 pdfplumber）
    try {
      await run(bundledPy(), ['-c', 'import pypdf, PIL'])
      return true
    } catch (e) {
      console.warn('[paper-reader] no usable python:', e.message)
      return false
    }
  })()
  return pyReadyPromise
}

async function jobLogSafe (ctx, level, text) {
  try { ctx.logger && ctx.logger.info && ctx.logger.info(text) } catch (e) {}
}

function runPy (args, opts = {}) {
  return run(pyBin(), args, opts)
}

function pyBin () {
  if (existsSync(VENV_PY)) return VENV_PY
  return bundledPy()
}

function run (cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(cmd, args, { ...opts })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolvePromise(out) : reject(new Error(tailError(err || out) || 'exit ' + code)))
  })
}

const SETTINGS_FILE = () => join(DSH_HOME, 'paper-reader', 'settings.json')

async function getSettings () { return (await readJson(SETTINGS_FILE(), {})) || {} }
async function saveSettings (patch) {
  const s = await getSettings()
  Object.assign(s, patch)
  await writeJson(SETTINGS_FILE(), s)
  return s
}

function providerIds (ctx) {
  try { return ctx.llm.listProviders().map((p) => p.id) } catch (e) { return [] }
}

async function resolveModel (ctx) {
  const st = await getSettings()
  const routes = providerIds(ctx)
  const provider = st.provider || process.env.DSH_PAPER_PROVIDER || (routes.includes('deepseek-account') ? 'deepseek-account' : routes[0])
  const model = st.model || process.env.DSH_PAPER_MODEL || 'deepseek-flash'
  return { provider, model, available: routes }
}

async function streamText (ctx, messages) {
  const { provider, model } = await resolveModel(ctx)
  if (!provider) throw new Error('没有可用的模型 provider')
  let text = ''
  for await (const ch of ctx.llm.stream({ provider, model, messages })) {
    if (ch.type === 'text-delta') text += ch.text
    else if (ch.type === 'finish' && ch.reason && (ch.reason.kind === 'error' || ch.reason.kind === 'aborted')) {
      const f = ch.reason.failure || {}
      throw new Error((f.code || 'unknown') + (f.message ? '：' + String(f.message).slice(0, 160) : ''))
    }
  }
  return text.trim()
}

/** 批量把章节标题翻译成中文 */
async function translateTitles (ctx, secs) {
  const titles = secs.map((x) => x.title)
  if (!titles.length) return 0
  const raw = await streamText(ctx, [
    { role: 'system', content: [{ type: 'text', text: '把输入的英文论文章节标题数组翻译成中文，输出 JSON 对象：键为原标题，值为中文。只输出 JSON。' }] },
    { role: 'user', content: [{ type: 'text', text: JSON.stringify(titles) }] }
  ])
  const map = parseJsonLoose(raw) || {}
  let n = 0
  secs.forEach((x) => {
    const zh = map[x.title]
    if (typeof zh === 'string' && zh.trim()) { x.title = zh.trim(); n++ }
  })
  return n
}

async function translate (ctx, text, instruction) {
  let sys = '你是学术论文翻译。把用户给出的英文论文片段翻译成准确、通顺的中文。要求：保留所有数学公式为 \\( ... \\) 形式；用 <p> 分段输出 HTML 片段；不要输出解释、不要用 Markdown；只输出译文 HTML。'
  if (instruction) sys += '\n本次的额外要求（来自用户，优先遵守）：' + instruction
  return streamText(ctx, [
    { role: 'system', content: [{ type: 'text', text: sys }] },
    { role: 'user', content: [{ type: 'text', text }] }
  ])
}

/* ---------------- 任务日志 ---------------- */

const JOB_LEVELS = ['info', 'ok', 'warn', 'error']
const CANCELLED = new Set()
const isCancelled = (id) => CANCELLED.has(id)
const jobFile = (id) => join(CONTENT, id, 'job.json')
const errText = (e) => String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300)

async function jobGet (id) { return await readJson(jobFile(id)) }

async function jobLog (id, level, text) {
  const job = (await jobGet(id)) || { paperId: id, status: 'running', startedAt: Date.now(), logs: [] }
  job.logs = job.logs || []
  job.logs.push({ ts: Date.now(), level: JOB_LEVELS.includes(level) ? level : 'info', text: String(text).slice(0, 500) })
  if (job.logs.length > 400) job.logs = job.logs.slice(-400)
  job.updatedAt = Date.now()
  await writeJson(jobFile(id), job)
  return job
}

async function jobPatch (id, patch) {
  const job = (await jobGet(id)) || { paperId: id, status: 'running', startedAt: Date.now(), logs: [] }
  Object.assign(job, patch, { updatedAt: Date.now() })
  await writeJson(jobFile(id), job)
  return job
}

/** 标题清洗：截到第一个句末，长度控制在 80 字内。 */
function cleanTitle (t) {
  let s = String(t).replace(/\s+/g, ' ').trim()
  const dot = s.indexOf('. ', 4)
  if (dot > 0 && dot < 90) s = s.slice(0, dot)
  return s.slice(0, 80)
}

/** 把全文切成若干节：优先按编号标题切，否则按页切。 */
function sectionsOf (pages) {
  const lines = []
  for (const p of pages) for (const l of String(p.text || '').split('\n')) lines.push({ page: p.n, text: l })
  const heads = []
  const numRe = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+(.+)$/
  const knownRe = /^(abstract|introduction|related work|background|method|methods|approach|experiments?|results?|discussion|conclusions?|references|appendix|limitations|acknowledg)\b/i
  const headingOf = (t) => {
    const m = t.match(numRe)
    if (m) {
      let rest = m[2].replace(/\s+/g, ' ').trim()
      // 修复 small-caps 拆字：R ELATED WORK → RELATED WORK
      rest = rest.replace(/\b([A-Z])\s+([A-Z]{2,})/g, '$1$2')
      const words = rest.split(' ').length
      if (rest.length <= 80 && words <= 10 && /^[A-Z]/.test(rest) && !/[.;:,]$/.test(rest) &&
        (rest === rest.toUpperCase() || /^[A-Z][a-z]/.test(rest))) {
        return m[1] + ' ' + rest
      }
    }
    if (knownRe.test(t) && t.length <= 40) return t
    return null
  }
  lines.forEach((l, i) => {
    const t = l.text.trim()
    const h = headingOf(t)
    if (h) heads.push({ idx: i, title: h, page: l.page })
  })
  if (heads.length < 3) {
    const chunks = []
    let buf = [], cur = 1
    for (const l of lines) {
      if (l.page !== cur && buf.join(' ').length > 2200) { chunks.push({ title: '第 ' + cur + ' 页', body: buf.join('\n') }); buf = [] }
      buf.push(l.text); cur = l.page
    }
    if (buf.length) chunks.push({ title: '第 ' + cur + ' 页', body: buf.join('\n') })
    return chunks
  }
  const out = []
  for (let k = 0; k < heads.length; k++) {
    const from = heads[k].idx
    const to = k + 1 < heads.length ? heads[k + 1].idx : lines.length
    const body = lines.slice(from + 1, to).map(l => l.text).join('\n').trim()
    out.push({ title: heads[k].title, body, page: heads[k].page || 0 })
  }
  return out
}

function sectionsFrom (pages) {
  return sectionsOf(pages)
    .filter((s) => s.body && s.body.trim().length > 40)
    .slice(0, 18)
    .map((s, i) => {
      const num = (s.title.match(/^(\d+(?:\.\d+)*)/) || [])[1]
      const sid = num ? 'sec-' + num.replace(/\./g, '-') : 'sec-' + (i + 1)
      return {
        id: sid,
        title: cleanTitle(s.title),
        level: num && num.includes('.') ? 3 : 2,
        source: s.body,
        page: s.page || 0,
        html: '',
        ok: false
      }
    })
}

async function writeZh (dir, secs, figuresHtml) {
  const parts = []
  for (const s of secs) {
    if (!s.html) continue
    const tag = s.level === 3 ? 'h3' : 'h2'
    parts.push('<' + tag + ' id="' + s.id + '">' + s.title + '</' + tag + '>')
    parts.push(s.html)
  }
  if (figuresHtml) parts.push(figuresHtml)
  await writeFile(join(dir, 'zh.html'), parts.join('\n'), 'utf8')
}

function parseJsonLoose (text) {
  const t = String(text || '').replace(/```[a-z]*\n?/gi, '').trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(t.slice(a, b + 1)) } catch (e) { return null }
}

/** 用一次 LLM 调用，从首页文本抽取标题/作者/年份/中文标题 */
async function extractMeta (ctx, ing) {
  const first = String((ing.pages && ing.pages[0] && ing.pages[0].text) || '').slice(0, 4000)
  if (!first.trim()) return null
  const sys = '你是论文元数据抽取器。只输出一个 JSON 对象，不要解释、不要代码块。字段：title（英文标题原文）、authors（作者，逗号分隔）、venue（会议/期刊/arXiv，未知填空字符串）、year（4 位年份，未知空字符串）、titleZh（标题的中文翻译）。'
  const raw = await streamText(ctx, [
    { role: 'system', content: [{ type: 'text', text: sys }] },
    { role: 'user', content: [{ type: 'text', text: first }] }
  ])
  const j = parseJsonLoose(raw)
  if (!j) throw new Error('元数据解析失败：' + raw.slice(0, 120))
  return {
    title: String(j.title || '').trim().slice(0, 200),
    authors: String(j.authors || '').trim().slice(0, 300),
    venue: String(j.venue || '').trim().slice(0, 120),
    year: String(j.year || '').trim().slice(0, 8),
    titleZh: String(j.titleZh || '').trim().slice(0, 200)
  }
}

const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/** 把抽取到的配图按「图 N」插入对应章节；找不到引用的按页码兜底插入，保证不丢图 */
async function placeFiguresByMention (id, secs, figs) {
  const placed = []
  const used = new Set()
  for (const f of figs) {
    const n = String(f.num || '').replace(/\D/g, '')
    if (!n) continue
    const re = new RegExp('图\\s*' + n + '(?!\\d)')
    let sec = null
    for (const x of secs) if (re.test(x.html || '')) { sec = x; break }
    if (!sec) continue
    const m = re.exec(sec.html)
    const at = sec.html.lastIndexOf('<p', m.index)
    const pos = at < 0 ? m.index : at
    const url = '/paper-reader/api/paper/' + id + '/figures/' + f.file
    const img = '<p style="text-align:center"><img src="' + url + '" alt="fig' + n + '" loading="lazy" /></p>'
    sec.html = sec.html.slice(0, pos) + img + '\n' + sec.html.slice(pos)
    placed.push(n)
    used.add(f.file)
  }
  // 兜底：没有被正文引用的图，按页码放到最近的章节末尾
  const left = figs.filter((f) => !used.has(f.file))
  for (const f of left) {
    let target = null
    if (f.page > 0) {
      for (const x of secs) if (x.page && x.page <= f.page) target = x
    }
    if (!target) target = secs[secs.length - 1]
    if (!target) break
    const n = String(f.num || '').replace(/\D/g, '') || 'x'
    const url = '/paper-reader/api/paper/' + id + '/figures/' + f.file
    target.html = String(target.html || '') + '\n<p style="text-align:center"><img src="' + url + '" alt="fig' + n + '" loading="lazy" /></p>'
    used.add(f.file)
  }
  return placed
}

async function buildFigures (ctx, id, dir, ing) {
  let imgs = (ing.images || []).slice(0, 24)
  const auto = imgs.length > 0
  if (!imgs.length) {
    try {
      await renderPdfPages(join(dir, 'paper.pdf'), join(dir, 'figures'), 1.4)
      const files = await readdir(join(dir, 'figures'))
      imgs = files.filter((f) => /^page\d+\.png$/.test(f))
        .map((f) => ({ file: f, page: Number(f.match(/\d+/)[0]) }))
        .sort((a, b) => a.page - b.page)
        .slice(0, 40)
    } catch (e) { await jobLog(id, 'warn', '页面渲染失败：' + errText(e)) }
  }
  if (!imgs.length) return ''
  const parts = ['<h2 id="sec-figures">' + (auto ? '附图（自动提取）' : '页面预览（版式与公式）') + '</h2>']
  for (const im of imgs) {
    parts.push('<p><img src="/paper-reader/api/paper/' + id + '/figures/' + im.file + '" alt="p' + im.page + '" /></p>')
    parts.push('<p style="text-align:center;color:#888;font-size:13px;">第 ' + im.page + ' 页</p>')
  }
  return parts.join('\n')
}

/* ---------------- 论文编辑代理 ---------------- */

const AGENT_SYS = [
  '你是论文阅读器里的编辑代理，可以修改一篇已翻译论文的结构与内容。',
  '每轮只输出一个 JSON 对象，不要输出其它文字：',
  '{"thought":"简短的中文思考","tool":"工具名","args":{...}}',
  '任务完成时输出 {"thought":"...","tool":"done"}。',
  '',
  '可用工具：',
  'get_paper() → 论文元信息与章节列表',
  'get_section({"id":"sec-1"}) → 该节原文与译文 HTML',
  'set_section_html({"id":"sec-1","html":"<p>...</p>"}) → 替换该节译文',
  'set_section_title({"id":"sec-1","title":"引言"}) → 修改该节标题',
  'translate_sections({"ids":["sec-1"],"instruction":"可选的额外要求"}) → 重新翻译这些节',
  'set_meta({"titleZh":"...","authors":"...","venue":"...","year":"...","abstract":"..."}) → 修改元信息（只传要改的字段）',
  'list_figures() → 文末图片列表（src 与页码）',
  'place_figures({"items":[{"src":"<url>","sectionId":"sec-2"}],"removePreview":true}) → 把图片插入指定章节',
  'remove_preview() → 删除文末图片区',
  'translate_titles() → 把全部章节标题翻译成中文',
  'pdf_info() → PDF 页数与页面尺寸',
  'page_lines({"page":7}) → 该页文本行（含 y 坐标）',
  'page_captions({"page":7}) → 该页的 Figure/Table 图注（含 y）',
  'candidate_regions({"page":7}) → 该页相邻文本行之间的空白带候选（含高度与内部文字量）',
  'inspect_region({"page":7,"top":400,"bottom":280}) → 检查某区域里有多少文字（越少越像图）',
  'crop_figure({"page":7,"top":400,"bottom":280,"num":"4"}) → 按坐标裁图并登记',
  'place_figure({"num":"4","sectionId":"sec-5"}) → 把裁好的图插入某节',
  'page_screenshot({"page":7,"sectionId":"sec-5"}) → 整页截图并插入（识别不到图时的兜底）',
  'page_tables({"page":8}) → 抽取该页表格（二维数组），用于把表格还原成 HTML',
  'insert_table({"page":8,"tableIndex":0,"sectionId":"sec-4","rows":[[...]]}) → 把表格转成 HTML 插入章节；rows 可传你整理好的二维数组（修正合并单元格）',
  'remove_images({"sectionId":"sec-1","srcContains":"fig-p1"}) → 删除章节里的图片（可按 src 片段过滤）',
  'search({"q":"关键词"}) → 在章节原文中搜索',
  'delete_section({"id":"sec-1"}) → 删除一节',
  'rebuild() → 按当前章节重新生成 zh.html',
  '',
  '规则：',
  '1) 用户明确指定的做法优先。用户说“识别不到就直接截图”，就立刻用 page_screenshot，不要反复尝试其它工具。',
  '2) 同一个工具连续失败两次，必须换方案，不要重复无效操作。',
  '3) 删除图片用 remove_images；不要用“改文字”绕过。',
  '4) 加表格用 insert_table；绝对不要用 set_section_html 覆盖整节，除非用户明确要求重写该节。',
  '4) 先 get_paper 了解现状；改动后 rebuild；不确定就用 search/get_section 查。'
].join('\n')

function parseFigures (html) {
  const out = []
  const re = /<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/g
  let m
  while ((m = re.exec(String(html || '')))) {
    const pm = /p(\d+)/.exec(m[2] || '')
    out.push({ src: m[1], page: pm ? Number(pm[1]) : 0 })
  }
  return out
}

async function saveSections (dir, meta, secs, figuresHtml) {
  await writeJson(join(dir, 'sections.json'), secs)
  await writeZh(dir, secs, figuresHtml || '')
  meta.sections = secs.map((s) => ({ id: s.id, title: s.title, level: s.level, text: (s.source || '').slice(0, 8000), status: s.ok ? 'ok' : 'failed' }))
  await writeJson(join(dir, 'meta.json'), meta)
}

async function agentStep (ctx, history) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await streamText(ctx, history)
      const j = parseJsonLoose(raw)
      if (!j || typeof j.tool !== 'string') throw new Error('代理输出无法解析：' + raw.slice(0, 160))
      return j
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 1200))
    }
  }
  throw lastErr
}

async function agentTool (ctx, id, name, a) {
  a = a || {}
  const dir = join(CONTENT, id)
  const meta = await readJson(join(dir, 'meta.json'), {})
  let secs = (await readJson(join(dir, 'sections.json'), [])) || []
  const idxOf = (sid) => secs.findIndex((x) => x.id === sid)
  const saveAll = async () => { await saveSections(dir, meta, secs, meta.figuresHtml) }

  switch (name) {
    case 'get_paper':
      return {
        title: meta.title, titleZh: meta.titleZh, authors: meta.authors, venue: meta.venue, year: meta.year,
        abstract: String(meta.abstract || '').slice(0, 300),
        hasPreview: !!meta.figuresHtml,
        previewImages: (String(meta.figuresHtml || '').match(/<img/g) || []).length,
        sections: secs.map((x) => ({ id: x.id, title: x.title, level: x.level, ok: !!x.ok, chars: String(x.html || '').length }))
      }
    case 'get_section': {
      const i = idxOf(a.id)
      if (i < 0) return { error: '没有这一节：' + a.id }
      return { id: secs[i].id, title: secs[i].title, source: String(secs[i].source || '').slice(0, 4000), html: String(secs[i].html || '').slice(0, 6000) }
    }
    case 'set_section_html': {
      const i = idxOf(a.id)
      if (i < 0) return { error: '没有这一节：' + a.id }
      const oldLen = String(secs[i].html || '').length
      const newLen = String(a.html || '').length
      if (!a.force && oldLen > 0 && newLen < oldLen * 0.5) {
        return { error: '新内容比原文少一半以上，可能覆盖丢失。加表格请用 insert_table；确实要整节重写请传 force:true' }
      }
      secs[i].html = String(a.html || '')
      secs[i].ok = true
      await saveAll()
      return { ok: true, id: a.id, chars: secs[i].html.length }
    }
    case 'set_section_title': {
      const i = idxOf(a.id)
      if (i < 0) return { error: '没有这一节：' + a.id }
      secs[i].title = String(a.title || '').slice(0, 120) || secs[i].title
      await saveAll()
      return { ok: true, id: a.id, title: secs[i].title }
    }
    case 'pdf_info': {
      const out = await runPy([join(ROOT, 'tools', 'pdf_layout.py'), join(dir, 'paper.pdf'), 'info'])
      return JSON.parse(out)
    }
    case 'page_lines': {
      const out = await runPy([join(ROOT, 'tools', 'pdf_layout.py'), join(dir, 'paper.pdf'), 'lines', String(a.page || 1)])
      return JSON.parse(out)
    }
    case 'page_captions': {
      const out = await runPy([join(ROOT, 'tools', 'pdf_layout.py'), join(dir, 'paper.pdf'), 'captions', String(a.page || 1)])
      return JSON.parse(out)
    }
    case 'candidate_regions': {
      const out = await runPy([join(ROOT, 'tools', 'pdf_layout.py'), join(dir, 'paper.pdf'), 'candidates', String(a.page || 1)])
      return JSON.parse(out)
    }
    case 'inspect_region': {
      const out = await runPy([join(ROOT, 'tools', 'pdf_layout.py'), join(dir, 'paper.pdf'), 'inspect', String(a.page), String(a.top), String(a.bottom)])
      return JSON.parse(out)
    }
    case 'crop_figure': {
      const page = Number(a.page || 0)
      if (!page) return { error: '需要 page' }
      const pageImg = join(dir, '_pages', 'page' + page + '.png')
      if (!existsSync(pageImg)) {
        await run('swift', [join(ROOT, 'tools', 'render_pages.swift'), join(dir, 'paper.pdf'), join(dir, '_pages'), '2'])
      }
      const info = JSON.parse(await runPy([join(ROOT, 'tools', 'pdf_layout.py'), join(dir, 'paper.pdf'), 'info']))
      const num = String(a.num || page)
      const file = 'fig-agent-' + num + '-p' + page + '.png'
      const script = [
        'import sys',
        'from PIL import Image',
        "im=Image.open(sys.argv[1]); W,H=im.size",
        "h=float(sys.argv[2]); top=float(sys.argv[3]); bottom=float(sys.argv[4])",
        "sy=H/h",
        "l=int(0.05*W); r=int(0.95*W)",
        "t=int(top*sy); b=int(bottom*sy)",
        "t=max(0,min(t,H-10)); b=max(t+20,min(b,H))",
        "c=im.crop((l,t,r,b))",
        "c.save(sys.argv[5])",
        "print(str(c.width)+'x'+str(c.height))"
      ].join('\n')
      const dim = (await runPy(['-c', script, pageImg, String(info.height), String(a.top), String(a.bottom), join(dir, 'figures', file)])).trim()
      return { file, url: '/paper-reader/api/paper/' + id + '/figures/' + file, page, num, size: dim }
    }
    case 'place_figure': {
      const i = idxOf(a.sectionId)
      if (i < 0) return { error: '没有这一节：' + a.sectionId }
      let file = a.file
      if (!file) {
        const files = (await readdir(join(dir, 'figures')).catch(() => [])).filter((f) => f.startsWith('fig-agent-' + String(a.num || '') + '-'))
        file = files.length ? files[files.length - 1] : ''
      }
      if (!file) return { error: '没有找到编号 ' + String(a.num) + ' 的裁剪图，请先 crop_figure' }
      const img = '<p style="text-align:center"><img src="/paper-reader/api/paper/' + id + '/figures/' + file + '" alt="fig' + String(a.num || '') + '" loading="lazy" /></p>'
      secs[i].html = String(secs[i].html || '') + '\n' + img
      await saveAll()
      return { ok: true, section: a.sectionId, file }
    }
    case 'page_tables': {
      await ensurePyDeps(ctx)
      const out = await runPy([join(ROOT, 'tools', 'pdf_tables.py'), join(dir, 'paper.pdf'), String(a.page || 1)])
      return JSON.parse(out)
    }
    case 'insert_table': {
      await ensurePyDeps(ctx)
      const page = Number(a.page || 1)
      const raw = JSON.parse(await runPy([join(ROOT, 'tools', 'pdf_tables.py'), join(dir, 'paper.pdf'), String(page)]))
      const tables = raw.tables || []
      if (!tables.length) return { error: '第 ' + page + ' 页没有识别到表格' }
      const t = tables[Number(a.tableIndex || 0)] || tables[0]
      // 允许代理自行整理（合并单元格常被抽成多行/多列）
      const rows = Array.isArray(a.rows) && a.rows.length ? a.rows : (t.rows || [])
      if (!rows.length) return { error: '表格为空' }
      const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      let html = '<table><thead><tr>' + rows[0].map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>'
      rows.slice(1).forEach((r) => { html += '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>' })
      html += '</tbody></table>'
      if (a.caption) html = '<p style="text-align:center;color:#666;font-size:13px">' + esc(a.caption) + '</p>' + html
      const i = idxOf(a.sectionId)
      if (i < 0) return { error: '没有这一节：' + a.sectionId }
      secs[i].html = insertAtBlock(secs[i].html, html, (a.blockIndex === undefined ? -1 : Number(a.blockIndex)))
      await saveAll()
      return { ok: true, rows: rows.length, cols: rows[0].length, section: a.sectionId }
    }
    case 'page_screenshot': {
      const page = Number(a.page || 0)
      if (!page) return { error: '需要 page' }
      const pageImg = join(dir, '_pages', 'page' + page + '.png')
      if (!existsSync(pageImg)) {
        await run('swift', [join(ROOT, 'tools', 'render_pages.swift'), join(dir, 'paper.pdf'), join(dir, '_pages'), '2'])
      }
      const file = 'page-shot-' + page + '.png'
      const target = join(dir, 'figures', file)
      if (!existsSync(target)) await writeFile(target, await readFile(pageImg))
      const i = a.sectionId ? idxOf(a.sectionId) : -1
      if (i < 0) return { file, url: '/paper-reader/api/paper/' + id + '/figures/' + file, note: '未指定有效 sectionId，只生成图片' }
      const img = '<p style="text-align:center"><img src="/paper-reader/api/paper/' + id + '/figures/' + file + '" alt="page' + page + '" loading="lazy" /></p>'
      secs[i].html = String(secs[i].html || '') + '\n' + img
      await saveAll()
      return { ok: true, section: a.sectionId, file }
    }
    case 'remove_images': {
      const i = a.sectionId ? idxOf(a.sectionId) : -1
      const needle = String(a.srcContains || '')
      let removed = 0
      const strip = (html) => String(html || '').replace(/<p[^>]*>\s*<img[^>]*>\s*<\/p>/g, (m) => {
        if (needle && m.indexOf(needle) < 0) return m
        removed++
        return ''
      })
      if (i >= 0) secs[i].html = strip(secs[i].html)
      else secs.forEach((x) => { x.html = strip(x.html) })
      await saveAll()
      return { ok: true, removed }
    }
    case 'list_saved_figures': {
      const files = (await readdir(join(dir, 'figures')).catch(() => [])).filter((f) => f.startsWith('fig-agent-'))
      return { files }
    }
    case 'translate_titles': {
      const titles = secs.map((x) => x.title)
      const raw = await streamText(ctx, [
        { role: 'system', content: [{ type: 'text', text: '把输入的英文论文章节标题数组翻译成中文，输出 JSON 对象：键为原标题，值为中文。只输出 JSON。' }] },
        { role: 'user', content: [{ type: 'text', text: JSON.stringify(titles) }] }
      ])
      const map = parseJsonLoose(raw) || {}
      let n = 0
      secs.forEach((x) => { const zh = map[x.title]; if (typeof zh === 'string' && zh.trim()) { x.title = zh.trim(); n++ } })
      await saveAll()
      return { ok: true, translated: n, total: titles.length }
    }
    case 'translate_sections': {
      const ids = Array.isArray(a.ids) && a.ids.length ? a.ids : secs.map((x) => x.id)
      let n = 0
      for (const sid of ids) {
        const i = idxOf(sid)
        if (i < 0) continue
        const out = await translate(ctx, secs[i].source, String(a.instruction || ''))
        if (!out.trim()) throw new Error('模型返回空内容（' + sid + '）')
        secs[i].html = out
        secs[i].ok = true
        n++
        await saveAll()
      }
      return { ok: true, translated: n }
    }
    case 'set_meta': {
      const fields = ['title', 'titleZh', 'authors', 'venue', 'year', 'abstract']
      fields.forEach((f) => { if (typeof a[f] === 'string' && a[f].trim()) meta[f] = a[f].trim() })
      await writeJson(join(dir, 'meta.json'), meta)
      return { ok: true, titleZh: meta.titleZh, authors: meta.authors, venue: meta.venue, year: meta.year }
    }
    case 'list_figures':
      return { preview: !!meta.figuresHtml, figures: parseFigures(meta.figuresHtml || '') }
    case 'place_figures': {
      const items = Array.isArray(a.items) ? a.items : []
      let placed = 0
      for (const it of items) {
        const i = idxOf(it.sectionId)
        if (i < 0) continue
        const html = '<p style="text-align:center"><img src="' + it.src + '" alt="figure" loading="lazy" /></p>'
        secs[i].html = String(secs[i].html || '') + '\n' + html
        placed++
      }
      if (a.removePreview !== false) meta.figuresHtml = ''
      await saveAll()
      return { ok: true, placed, removePreview: a.removePreview !== false }
    }
    case 'remove_preview':
      meta.figuresHtml = ''
      await saveAll()
      return { ok: true }
    case 'search': {
      const q = String(a.q || '').toLowerCase()
      const hits = []
      secs.forEach((x) => {
        const src = String(x.source || '')
        const p = src.toLowerCase().indexOf(q)
        if (q && p >= 0) hits.push({ id: x.id, title: x.title, snippet: src.slice(Math.max(0, p - 60), p + 120) })
      })
      return { hits: hits.slice(0, 10) }
    }
    case 'delete_section': {
      const i = idxOf(a.id)
      if (i < 0) return { error: '没有这一节：' + a.id }
      secs.splice(i, 1)
      await saveAll()
      return { ok: true, deleted: a.id }
    }
    case 'rebuild':
      await saveAll()
      return { ok: true, sections: secs.length }
    default:
      return { error: '未知工具：' + name }
  }
}

async function agentLoop (ctx, id, text) {
  const steps = []
  for (let turn = 0; turn < 30; turn++) {
    if (isCancelled(id)) {
      CANCELLED.delete(id)
      await jobLog(id, 'warn', '已中断（用户手动）')
      return
    }
    const transcript = steps.length
      ? steps.map((x, i) => (i + 1) + '. ' + x.tool + '(' + JSON.stringify(x.args) + ') → ' + x.obs).join('\n')
      : '（还没有执行任何操作）'
    const user = '用户要求：' + text + '\n\n已完成的操作：\n' + transcript + '\n\n请输出下一步 JSON。'
    const step = await agentStep(ctx, [
      { role: 'system', content: [{ type: 'text', text: AGENT_SYS }] },
      { role: 'user', content: [{ type: 'text', text: user }] }
    ])
    if (step.thought) await jobLog(id, 'info', '思考：' + String(step.thought).slice(0, 200))
    if (step.tool === 'done') { await jobLog(id, 'ok', '代理认为任务已完成'); return }
    let obs
    try { obs = await agentTool(ctx, id, step.tool, step.args) }
    catch (e) { obs = { error: errText(e) } }
    const brief = JSON.stringify(obs)
    await jobLog(id, 'info', '调用 ' + step.tool + ' · ' + brief.slice(0, 200))
    steps.push({ tool: step.tool, args: step.args || {}, obs: brief.slice(0, 1500) })
  }
  await jobLog(id, 'warn', '达到步数上限，停止')
}

async function processUpload (ctx, id, opts = {}) {
  CANCELLED.delete(id)
  const dir = join(CONTENT, id)
  const instruction = String(opts.instruction || '').trim()
  const only = Array.isArray(opts.only) ? opts.only : null
  const t0 = Date.now()
  try {
    await ensurePyDeps(ctx)
    let secs
    let ing = null
    let figuresHtml = null
    let meta = await readJson(join(dir, 'meta.json'), {})

    if (only) {
      secs = (await readJson(join(dir, 'sections.json'), [])) || []
      figuresHtml = meta.figuresHtml || ''
      await jobLog(id, 'info', '按指令重译 ' + only.length + ' 节')
    } else {
      await jobLog(id, 'info', '开始解析 PDF…')
      try {
        await runPy([join(ROOT, 'tools', 'pdf_ingest.py'), join(dir, 'paper.pdf'), dir], { cwd: dir })
      } catch (e) {
        await jobLog(id, 'error', 'PDF 解析失败：' + errText(e))
        throw e
      }
      ing = await readJson(join(dir, 'ingest.json'))
      if (!ing) throw new Error('解析结果为空')
      try {
        await runPy([join(ROOT, 'tools', 'extract_figures.py'), join(dir, 'paper.pdf'), dir], { cwd: dir })
        const figs = await readJson(join(dir, 'figures.json'), [])
        if (Array.isArray(figs) && figs.length) {
          ing.figures = figs.filter((f) => f.kind === 'figure')
          await jobLog(id, 'ok', '提取到 ' + ing.figures.length + ' 张配图（图注裁剪）')
        }
      } catch (e) {
        await jobLog(id, 'warn', '配图抽取失败：' + errText(e))
      }
      await jobLog(id, 'ok', '解析完成：' + ing.pages.length + ' 页，内嵌图片 ' + (ing.images || []).length + ' 张')
      secs = sectionsFrom(ing.pages)
      await jobLog(id, 'info', '切分章节：' + secs.length + ' 节')
      if (!secs.length) throw new Error('未能从 PDF 中提取到正文')
      try {
        const nT = await translateTitles(ctx, secs)
        await jobLog(id, 'ok', '目录标题已翻译：' + nT + '/' + secs.length)
      } catch (e) {
        await jobLog(id, 'warn', '标题翻译失败：' + errText(e))
      }
      if (ing && Array.isArray(ing.figures) && ing.figures.length) {
        // 先正常翻译，翻译完成后再按「图 N」插入（见下方循环结束后）
        figuresHtml = ''
      } else {
        figuresHtml = await buildFigures(ctx, id, dir, ing)
      }
      if (figuresHtml) {
        // 页面渲染得到的整页预览：按页码直接分配到对应章节，避免文末堆一坨
        if (!(ing.images && ing.images.length)) {
          const figs = parseFigures(figuresHtml)
          const buckets = secs.map(() => [])
          figs.forEach((f, i) => {
            let idx = -1
            if (f.page > 0) for (let k = 0; k < secs.length; k++) if (secs[k].page && secs[k].page <= f.page) idx = k
            if (idx < 0) idx = Math.min(secs.length - 1, Math.floor(i * secs.length / Math.max(1, figs.length)))
            buckets[idx].push(f)
          })
          buckets.forEach((arr, k) => {
            if (!arr.length) return
            secs[k].html = String(secs[k].html || '') + '\n' + arr.map((f) => '<p style="text-align:center"><img src="' + f.src + '" alt="p' + f.page + '" loading="lazy" /></p>').join('\n')
          })
          figuresHtml = ''
          await jobLog(id, 'ok', '配图按页内联到 ' + buckets.filter((b) => b.length).length + ' 个章节（共 ' + figs.length + ' 页）')
        } else {
          await jobLog(id, 'ok', '配图已生成')
        }
      } else {
        await jobLog(id, 'warn', '没有可用的配图（无内嵌图片且页面渲染失败）')
      }

      meta.title = meta.title || ing.title || id
      meta.titleZh = meta.titleZh || (secs[0] ? secs[0].title : meta.title)
      try {
        await jobLog(id, 'info', '抽取标题 / 作者 / 年份…')
        const info = await extractMeta(ctx, ing)
        if (info) {
          if (info.title) { meta.title = info.title; meta.titleZh = info.titleZh || meta.titleZh }
          meta.authors = info.authors || meta.authors || ''
          meta.venue = info.venue || meta.venue || ''
          meta.year = info.year || meta.year || ''
          await jobLog(id, 'ok', '元信息：' + [meta.titleZh, meta.authors, meta.venue, meta.year].filter(Boolean).join(' · ').slice(0, 160))
        }
      } catch (e) {
        await jobLog(id, 'warn', '元信息抽取失败：' + errText(e))
      }
    }

    const targets = only ? only.map((i) => secs[i]).filter(Boolean) : secs.slice()
    const mdl = await resolveModel(ctx)
    if (!mdl.provider) {
      await jobLog(id, 'error', '没有可用的模型 provider：请在日志面板右上角选择模型后再重试')
    } else {
      await jobLog(id, 'info', '使用模型：' + mdl.provider + ' / ' + mdl.model)
    }
    let failures = 0
    for (let k = 0; k < targets.length; k++) {
      if (isCancelled(id)) {
        CANCELLED.delete(id)
        await jobLog(id, 'warn', '已中断（用户手动），完成 ' + k + '/' + targets.length + ' 节')
        await jobPatch(id, { status: 'cancelled', endedAt: Date.now() })
        meta.status = secs.some((x) => x.ok) ? 'partial' : 'failed'
        await writeJson(join(dir, 'meta.json'), meta)
        return
      }
      const s = targets[k]
      if (/^(references|bibliography|参考文献)/i.test(String(s.title).trim())) {
        s.html = String(s.source || '').split(/\n{2,}/).map((p) => '<p>' + escHtml(p) + '</p>').join('\n')
        s.ok = true
        await writeJson(join(dir, 'sections.json'), secs)
        await writeZh(dir, secs, figuresHtml)
        await jobLog(id, 'info', '跳过参考文献翻译 · ' + s.title)
        continue
      }
      await jobLog(id, 'info', '翻译 ' + (k + 1) + '/' + targets.length + ' · ' + s.title)
      try {
        let html = ''
        const chunks = []
        for (let off = 0; off < s.source.length; off += 6000) chunks.push(s.source.slice(off, off + 6000))
        for (let ci = 0; ci < chunks.length; ci++) {
          const t1 = Date.now()
          const part = await translate(ctx, chunks[ci], instruction)
          html += part + '\n'
          if (chunks.length > 1) {
            await jobLog(id, 'info', '  ↳ 片段 ' + (ci + 1) + '/' + chunks.length + ' · 输入 ' + chunks[ci].length + ' 字符 · 输出 ' + part.length + ' 字 · ' + (Date.now() - t1) + 'ms')
          }
        }
        if (!html.trim()) throw new Error('模型返回空内容')
        s.html = html
        s.ok = true
        await jobLog(id, 'ok', '完成 · ' + s.title + '（' + html.length + ' 字）')
      } catch (e) {
        failures++
        s.ok = false
        s.html = '<p><em>（本节自动翻译失败：' + errText(e).slice(0, 160) + '）</em></p>'
        await jobLog(id, 'error', '失败 · ' + s.title + '：' + errText(e) + (mdl.provider ? '（模型 ' + mdl.provider + '/' + mdl.model + '）' : ''))
      }
      await writeJson(join(dir, 'sections.json'), secs)
      await writeZh(dir, secs, figuresHtml)
    }

    if (ing && Array.isArray(ing.figures) && ing.figures.length) {
      const placed = await placeFiguresByMention(id, secs, ing.figures)
      await jobLog(id, 'ok', '配图已插入 ' + placed.length + ' 张按正文引用，其余按页码兜底（共 ' + ing.figures.length + ' 张）')
      figuresHtml = ''
      await writeZh(dir, secs, '')
    }
    const absSec = secs.find((s) => /abstract|摘要/i.test(s.title))
    if (absSec && absSec.html) meta.abstract = stripTags(absSec.html).slice(0, 1500)
    meta.sections = secs.map((s) => ({ id: s.id, title: s.title, level: s.level, text: s.source.slice(0, 8000), status: s.ok ? 'ok' : 'failed' }))
    meta.figuresHtml = figuresHtml || ''
    meta.status = failures ? 'partial' : 'ready'
    meta.updatedAt = Date.now()
    meta.hasPdf = true
    meta.pdfPath = 'paper.pdf'
    await writeJson(join(dir, 'meta.json'), meta)
    await rm(join(dir, 'ingest.json'), { force: true })

    const sec = Math.round((Date.now() - t0) / 1000)
    await jobLog(id, failures ? 'warn' : 'ok', '任务结束：成功 ' + (targets.length - failures) + ' 节' + (failures ? '，失败 ' + failures + ' 节' : '') + '，用时 ' + sec + 's')
    await jobPatch(id, { status: failures ? 'partial' : 'done', endedAt: Date.now() })
  } catch (e) {
    await jobLog(id, 'error', '任务失败：' + errText(e))
    await jobPatch(id, { status: 'failed', endedAt: Date.now() })
    const meta = await readJson(join(dir, 'meta.json'), {})
    meta.status = 'failed'
    meta.error = errText(e)
    await writeJson(join(dir, 'meta.json'), meta)
  }
}

async function createPaperFromUpload (ctx, fileName, buf, collectionId) {
  const base = basename(fileName || 'paper.pdf').replace(/\.pdf$/i, '')
  const id = slug(base) + '-' + Date.now().toString(36)
  const dir = join(CONTENT, id)
  await ensureDir(join(dir, 'figures'))
  await writeFile(join(dir, 'paper.pdf'), buf)
  const cols = await listCollections()
  const col = cols.some((c) => c.id === collectionId) ? collectionId : 'drafts'
  await writeJson(join(dir, 'meta.json'), {
    id, collectionId: col, title: base, titleZh: base, authors: '', venue: '', year: '',
    abstract: '', sections: [], figures: 0, hasOriginal: false, hasPdf: true,
    pdfPath: 'paper.pdf', status: 'processing', createdAt: Date.now()
  })
  await writeFile(join(dir, 'zh.html'), '<p>正在解析与翻译，请稍后刷新…</p>', 'utf8')
  await writeJson(jobFile(id), { paperId: id, status: 'running', startedAt: Date.now(), instruction: '', runs: 1, logs: [] })
  await jobLog(id, 'info', '已创建论文「' + base + '」，开始处理（上传 ' + Math.round(buf.length / 1024) + ' KB，插件 v' + PLUGIN_VERSION + '）')
  processUpload(ctx, id).catch((e) => {
    console.error('[paper-reader] processUpload failed:', e)
    jobLog(id, 'error', '任务异常：' + errText(e)).catch(() => {})
    jobPatch(id, { status: 'failed', endedAt: Date.now() }).catch(() => {})
  })
  return { id }
}

/* ---------------- 手动图片编辑 ---------------- */

/** 渲染 PDF 页面：macOS 用 PDFKit(swift)，Linux 回退 poppler(pdftoppm) */
async function renderPdfPages (pdf, outdir, scale) {
  await ensureDir(outdir)
  try {
    await run('swift', [join(ROOT, 'tools', 'render_pages.swift'), pdf, outdir, String(scale)])
    return 'swift'
  } catch (e) {
    const dpi = Math.round(72 * scale)
    await run('pdftoppm', ['-png', '-r', String(dpi), pdf, join(outdir, 'page')])
    return 'pdftoppm'
  }
}

/** 兼容 pdftoppm 的 page-01.png 命名 */
async function pageImagePath (dir, page) {
  const candidates = [
    join(dir, '_pages', 'page' + page + '.png'),
    join(dir, '_pages', 'page-' + page + '.png'),
    join(dir, '_pages', 'page-' + String(page).padStart(2, '0') + '.png'),
    join(dir, '_pages', 'page-' + String(page).padStart(3, '0') + '.png')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

async function ensurePageImage (dir, page) {
  let img = await pageImagePath(dir, page)
  if (img) return img
  await renderPdfPages(join(dir, 'paper.pdf'), join(dir, '_pages'), 2)
  img = await pageImagePath(dir, page)
  if (!img) throw new Error('页面渲染失败：需要 macOS swift 或 poppler 的 pdftoppm')
  return img
}

async function pageSize (dir) {
  const out = await runPy([join(ROOT, 'tools', 'pdf_layout.py'), join(dir, 'paper.pdf'), 'info'])
  return JSON.parse(out)
}

/** 按页面坐标（pt，左上原点）裁剪 */
async function cropRegion (dir, page, x, y, w, h) {
  await ensurePyDeps(null)
  const pageImg = await ensurePageImage(dir, page)
  const info = await pageSize(dir)
  const file = 'manual-' + Date.now() + '.png'
  const script = [
    'import sys',
    'from PIL import Image',
    'im=Image.open(sys.argv[1]); W,H=im.size',
    'pw=float(sys.argv[2]); ph=float(sys.argv[3])',
    'x=float(sys.argv[4]); y=float(sys.argv[5]); w=float(sys.argv[6]); h=float(sys.argv[7])',
    'sx=W/pw; sy=H/ph',
    'l=max(0,int(x*sx)); t=max(0,int(y*sy)); r=min(W,int((x+w)*sx)); b=min(H,int((y+h)*sy))',
    'if r-l<20 or b-t<20: raise SystemExit("区域太小")',
    'im.crop((l,t,r,b)).save(sys.argv[8])'
  ].join('\n')
  await runPy(['-c', script, pageImg, String(info.width), String(info.height), String(x), String(y), String(w), String(h), join(dir, 'figures', file)])
  return file
}

/** 把一段 HTML 插到第 blockIndex 个 <p> 之前；index<0 表示追加到末尾 */
function insertAtBlock (html, tag, blockIndex) {
  const h = String(html || '')
  if (blockIndex === undefined || blockIndex === null || blockIndex < 0) return h + '\n' + tag
  let pos = -1
  for (let n = 0; n <= blockIndex; n++) {
    pos = h.indexOf('<p', pos + 1)
    if (pos < 0) return h + '\n' + tag
  }
  return h.slice(0, pos) + tag + '\n' + h.slice(pos)
}

/** 把章节 HTML 拆成顶层块（p/table/ul/ol/pre/blockquote/figure） */
function blocksOf (html) {
  const src = String(html || '')
  const re = /<(p|table|ul|ol|pre|blockquote|figure)\b[\s\S]*?<\/\1>/gi
  return src.match(re) || []
}
function joinBlocks (blocks) { return blocks.join('\n') }

async function loadSections (dir) {
  return (await readJson(join(dir, 'sections.json'), [])) || []
}
function imgTag (id, file, alt) {
  return '<p style="text-align:center"><img src="/paper-reader/api/paper/' + id + '/figures/' + file + '" alt="' + (alt || 'figure') + '" loading="lazy" /></p>'
}

/* ---------------- 问答 ---------------- */

async function qaOf (id) {
  const builtin = (await readJson(join(CONTENT, id, 'qa.json'), [])) || []
  const user = (await readJson(join(QA_DIR, id + '.json'), [])) || []
  return [...builtin.map(e => ({ ...e, builtin: true })), ...user]
}
async function addQa (id, entry) {
  await ensureDir(QA_DIR)
  const list = await qaOf(id)
  list.push(entry)
  await writeJson(join(QA_DIR, id + '.json'), list)
  return entry
}

function buildMessages (meta, sectionTitle, sectionText, question) {
  const sys = '你是一位深度学习论文助教，专长是大模型量化。请基于给定论文内容用中文回答：准确、具体，必要时给公式；公式用 \\( ... \\) 表示；不要用 Markdown 表格；回答不超过 800 字。材料不足时明确说明。'
  const ctxText = ['【论文】' + (meta.titleZh || meta.title || ''), '【章节】' + (sectionTitle || ''), '【内容】', (sectionText || meta.abstract || '').slice(0, 6000), '', '【问题】' + question].join('\n')
  return [
    { role: 'system', content: [{ type: 'text', text: sys }] },
    { role: 'user', content: [{ type: 'text', text: ctxText }] }
  ]
}

/* ---------------- 路由 ---------------- */

export function apply (ctx) {
  // 任何注册失败都只记录，不抛错——避免插件把宿主启动带崩
  try {
    process.on('unhandledRejection', (e) => {
      console.error('[paper-reader] unhandled rejection:', e)
    })
  } catch (e) {}
  try {
    if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
      console.error('[paper-reader] webServer.register 不可用，插件跳过注册')
      return
    }
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => serveNode(ctx, req, res)
    }), 'paper-reader: routes')
  } catch (e) {
    console.error('[paper-reader] 路由注册失败，插件跳过：', e)
  }
}

function toWebRequest (req) {
  const url = new URL(req.url || '/', 'http://localhost')
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (v === undefined) continue
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
  }
  const init = { method: req.method || 'GET', headers }
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = Readable.toWeb(req)
    init.duplex = 'half'
  }
  return new Request(url, init)
}

async function serveNode (ctx, req, res) {
  let response
  try { response = await handle(ctx, toWebRequest(req)) }
  catch (err) { console.error('[paper-reader]', err); response = json({ error: String((err && err.message) || err) }, 500) }
  res.statusCode = response.status
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') { try { res.setHeader(k, v) } catch (e) {} } })
  if (!response.body) { res.end(); return }
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
  } catch (err) { console.error('[paper-reader] stream', err) }
  res.end()
}

async function handle (ctx, request) {
  const url = new URL(request.url, 'http://localhost')
  let path = decodeURIComponent(url.pathname)
  if (path === PREFIX) path = PREFIX + '/'
  const rel = path.slice(PREFIX.length)
  const method = request.method

  try {
    if (rel === '/app' || rel === '/') return serveFile(join(ASSETS, 'app.html'))
    if (rel === '/ping') return new Response('pong', { headers: { 'content-type': 'text/plain' } })
    if (rel.startsWith('/assets/')) {
      const f = safeJoin(ASSETS, rel.slice(8))
      return f ? serveFile(f) : fail('bad path', 400)
    }

    if (rel === '/api/library' && method === 'GET') {
      const [papers, collections] = await Promise.all([listPapers(), listCollections()])
      return json({ papers, collections })
    }
    if (rel === '/api/collections' && method === 'GET') return json(await listCollections())
    if (rel === '/api/collections' && method === 'POST') {
      const body = await request.json().catch(() => null)
      const name = String((body && body.name) || '').trim().slice(0, 40)
      if (!name) return fail('分区名不能为空')
      const cols = await listCollections()
      if (cols.some(c => c.name === name)) return fail('同名分区已存在')
      const col = { id: slug(name) + '-' + (cols.length + 1), name, order: cols.length }
      cols.push(col)
      await saveCollections(cols)
      return json(col)
    }
    const cm = rel.match(/^\/api\/collections\/([^/]+)$/)
    if (cm) {
      const id = cm[1]
      if (id === 'drafts') return fail('默认分区不可修改或删除', 403)
      const cols = await listCollections()
      const col = cols.find(c => c.id === id)
      if (!col) return fail('not found', 404)
      if (method === 'PATCH') {
        const body = await request.json().catch(() => null)
        if (body && (body.move === 'up' || body.move === 'down')) {
          const idx = cols.findIndex((c) => c.id === id)
          const j = body.move === 'up' ? idx - 1 : idx + 1
          if (idx <= 0 || j <= 0 || j >= cols.length) return fail('无法移动', 400)
          const tmp = cols[idx]
          cols[idx] = cols[j]
          cols[j] = tmp
          cols.forEach((c, i) => { c.order = i })
          await saveCollections(cols)
          return json(cols)
        }
        const name = String((body && body.name) || '').trim().slice(0, 40)
        if (!name) return fail('分区名不能为空')
        if (cols.some(c => c.name === name && c.id !== id)) return fail('同名分区已存在')
        col.name = name
        await saveCollections(cols)
        return json(col)
      }
      if (method === 'DELETE') {
        const papers = await listPapers()
        for (const p of papers) {
          if (p.collectionId !== id) continue
          const meta = await metaOf(p.id)
          meta.collectionId = 'drafts'
          await writeJson(join(CONTENT, p.id, 'meta.json'), meta)
        }
        await saveCollections(cols.filter(c => c.id !== id))
        return json({ ok: true })
      }
    }

    if (rel === '/api/upload' && method === 'POST') {
      const name = url.searchParams.get('name') || 'paper.pdf'
      const collection = url.searchParams.get('collection') || 'drafts'
      const chunks = []
      let size = 0
      for await (const chunk of request.body) {
        size += chunk.length
        if (size > 60 * 1024 * 1024) return fail('文件过大（>60MB），请先在本地压缩或拆分', 413)
        chunks.push(Buffer.from(chunk))
      }
      const buf = Buffer.concat(chunks)
      if (buf.length < 1000) return fail('文件为空')
      return json(await createPaperFromUpload(ctx, name, buf, collection))
    }

    const pim = rel.match(/^\/api\/paper\/([^/]+)\/page-image\/([0-9]+)$/)
    if (pim && method === 'GET') {
      const id = pim[1]
      if (!ID_RE.test(id)) return fail('bad id', 400)
      const dir = join(CONTENT, id)
      if (!existsSync(join(dir, 'paper.pdf'))) return fail('no pdf', 404)
      const img = await ensurePageImage(dir, Number(pim[2]))
      return serveFile(img, { 'cache-control': 'no-cache' })
    }

    const bm = rel.match(/^\/api\/paper\/([^/]+)\/block\/(update|delete|insert|move)$/)
    if (bm && method === 'POST') {
      const id = bm[1]
      if (!ID_RE.test(id)) return fail('bad id', 400)
      const dir = join(CONTENT, id)
      const body = await request.json().catch(() => null)
      if (!body) return fail('缺少参数')
      const secs = await loadSections(dir)
      const si = Number(body.sectionIndex)
      if (!(si >= 0 && si < secs.length)) return fail('章节不存在')
      const blocks = blocksOf(secs[si].html)
      const bi = Number(body.blockIndex)
      if (!(bi >= 0 && bi < blocks.length)) return fail('段落不存在')
      if (bm[2] === 'update') {
        const html = String(body.html || '').trim()
        if (!html) return fail('内容不能为空（要删除请用删除块）')
        blocks[bi] = html
      } else if (bm[2] === 'delete') {
        blocks.splice(bi, 1)
      } else if (bm[2] === 'insert') {
        blocks.splice(bi + 1, 0, String(body.html || '<p></p>'))
      } else if (bm[2] === 'move') {
        const dir2 = body.dir === 'up' ? -1 : 1
        const j = bi + dir2
        if (j >= 0 && j < blocks.length) {
          const tmp = blocks[bi]; blocks[bi] = blocks[j]; blocks[j] = tmp
        } else if (dir2 < 0) {
          // 跨章节：本段移到上一章节末尾
          if (si === 0) return fail('已经是第一节的开头')
          const moved = blocks.splice(bi, 1)[0]
          const prevBlocks = blocksOf(secs[si - 1].html)
          prevBlocks.push(moved)
          secs[si - 1].html = joinBlocks(prevBlocks)
        } else {
          // 跨章节：本段移到下一章节开头
          if (si === secs.length - 1) return fail('已经是最后一节的末尾')
          const moved = blocks.splice(bi, 1)[0]
          const nextBlocks = blocksOf(secs[si + 1].html)
          nextBlocks.unshift(moved)
          secs[si + 1].html = joinBlocks(nextBlocks)
        }
      }
      const meta = await readJson(join(dir, 'meta.json'), {})
      secs[si].html = joinBlocks(blocks)
      await saveSections(dir, meta, secs, meta.figuresHtml || '')
      return json({ ok: true, blocks: blocks.length })
    }

    const fe = rel.match(/^\/api\/paper\/([^/]+)\/figure\/(crop|remove|replace|insert|move)$/)
    if (fe && method === 'POST') {
      const id = fe[1]
      if (!ID_RE.test(id)) return fail('bad id', 400)
      const dir = join(CONTENT, id)
      const body = await request.json().catch(() => null)
      if (!body) return fail('缺少参数')
      const secs = await loadSections(dir)
      let idx = -1
      if (Number.isInteger(body.sectionIndex) && body.sectionIndex >= 0 && body.sectionIndex < secs.length) idx = body.sectionIndex
      else if (body.sectionId) idx = secs.findIndex((x) => x.id === body.sectionId)
      let file = ''
      if (fe[2] === 'crop') {
        const page = Number(body.page)
        if (!page) return fail('需要 page')
        file = await cropRegion(dir, page, Number(body.x || 0), Number(body.y || 0), Number(body.w || 0), Number(body.h || 0))
        return json({ ok: true, file, src: '/paper-reader/api/paper/' + id + '/figures/' + file })
      }
      if (fe[2] === 'remove') {
        if (idx < 0) return fail('section 不存在')
        const needle = String(body.src || '')
        const re = /<p[^>]*>\s*<img[^>]*>\s*<\/p>/g
        let removed = false
        secs[idx].html = String(secs[idx].html || '').replace(re, (m) => {
          if (!removed && (!needle || m.indexOf(needle) >= 0)) { removed = true; return '' }
          return m
        })
        await saveSections(dir, await readJson(join(dir, 'meta.json'), {}), secs, (await readJson(join(dir, 'meta.json'), {})).figuresHtml || '')
        return json({ ok: true, removed })
      }
      const meta = await readJson(join(dir, 'meta.json'), {})
      if (fe[2] === 'move') {
        const from = Number(body.fromSectionIndex)
        const to = Number(body.toSectionIndex)
        if (!(from >= 0 && from < secs.length && to >= 0 && to < secs.length)) return fail('章节不存在')
        const needle = String(body.src || '')
        const re = /<p[^>]*>\s*<img[^>]*>\s*<\/p>/g
        let tag = ''
        secs[from].html = String(secs[from].html || '').replace(re, (m) => {
          if (!tag && m.indexOf(needle) >= 0) { tag = m; return '' }
          return m
        })
        if (!tag) return fail('源章节里没找到这张图')
        secs[to].html = insertAtBlock(secs[to].html, tag, (body.blockIndex === undefined ? -1 : Number(body.blockIndex)))
        await saveSections(dir, meta, secs, meta.figuresHtml || '')
        return json({ ok: true })
      }
      if (fe[2] === 'insert') {
        if (idx < 0) return fail('section 不存在')
        const src = String(body.src || '')
        const m = /figures\/([^"']+)$/.exec(src)
        if (!m) return fail('无效图片地址')
        secs[idx].html = insertAtBlock(secs[idx].html, imgTag(id, m[1], body.alt), (body.blockIndex === undefined ? -1 : Number(body.blockIndex)))
        await saveSections(dir, meta, secs, meta.figuresHtml || '')
        return json({ ok: true, file: m[1] })
      }
      // replace: 用新裁的图替换旧图
      if (idx < 0) return fail('section 不存在')
      const oldSrc = String(body.oldSrc || '')
      const file2 = String(body.file || '')
      const m = file2 ? [null, file2] : /figures\/([^"']+)$/.exec(String(body.src || ''))
      if (!m) return fail('替换失败：缺少新图片')
      const newTag = imgTag(id, m[1], body.alt)
      const re = /<p[^>]*>\s*<img[^>]*>\s*<\/p>/g
      let done = false
      secs[idx].html = String(secs[idx].html || '').replace(re, (tag) => {
        if (!done && (!oldSrc || tag.indexOf(oldSrc) >= 0)) { done = true; return newTag }
        return tag
      })
      if (!done) return fail('替换失败：该章节里没找到旧图片')
      await saveSections(dir, meta, secs, meta.figuresHtml || '')
      return json({ ok: true, file: m[1] })
    }

    const pm = rel.match(/^\/api\/paper\/([^/]+)(?:\/(zh|pdf|web|figures\/(.+))?)?$/)
    if (pm) {
      const id = pm[1]
      if (!ID_RE.test(id)) return fail('bad id', 400)
      const dir = join(CONTENT, id)
      if (pm[2] === undefined) {
        const meta = await metaOf(id)
        if (!meta) return fail('not found', 404)
        if (method === 'PATCH') {
          const body = await request.json().catch(() => null)
          if (body && body.collectionId) {
            const cols = await listCollections()
            if (!cols.some(c => c.id === body.collectionId)) return fail('分区不存在', 400)
            meta.collectionId = body.collectionId
          }
          if (body && typeof body.titleZh === 'string' && body.titleZh.trim()) meta.titleZh = body.titleZh.trim().slice(0, 120)
          if (body && typeof body.title === 'string' && body.title.trim()) meta.title = body.title.trim().slice(0, 160)
          await writeJson(join(dir, 'meta.json'), meta)
          return json(meta)
        }
        if (method === 'DELETE') {
          await rm(dir, { recursive: true, force: true })
          await rm(join(QA_DIR, id + '.json'), { force: true })
          return json({ ok: true })
        }
        return json({ meta, qa: await qaOf(id) })
      }
      if (pm[2] === 'zh') return serveFile(join(dir, 'zh.html'))
      if (pm[3] !== undefined) {
        const f = safeJoin(join(dir, 'figures'), pm[3])
        return f ? serveFile(f) : fail('bad path', 400)
      }
      if (pm[2] === 'web') return serveFile(join(dir, 'original.html'), { 'content-type': 'text/html; charset=utf-8' })
      if (pm[2] === 'pdf') {
        const local = join(dir, 'paper.pdf')
        if (existsSync(local)) return serveFile(local, { 'content-disposition': 'inline' })
        const meta = await metaOf(id)
        if (meta && meta.pdfPath) return serveFile(resolve(meta.pdfPath), { 'content-disposition': 'inline' })
        return fail('no pdf', 404)
      }
    }

    if (rel === '/api/models' && method === 'GET') {
      const providers = []
      let list = []
      try { list = ctx.llm.listProviders() } catch (e) {}
      for (const p of list) {
        let models = []
        try { models = await ctx.llm.listModels(p.id) } catch (e) { models = [] }
        providers.push({ id: p.id, name: p.name || p.id, models: models.map((m) => ({ id: m.id, name: m.name })) })
      }
      const cur = await resolveModel(ctx)
      return json({ providers, current: { provider: cur.provider, model: cur.model } })
    }
    if (rel === '/api/settings' && method === 'GET') return json(await getSettings())
    if (rel === '/api/settings' && method === 'POST') {
      const body = await request.json().catch(() => null)
      const patch = {}
      if (body && typeof body.provider === 'string') patch.provider = body.provider.slice(0, 60)
      if (body && typeof body.model === 'string') patch.model = body.model.slice(0, 80)
      return json(await saveSettings(patch))
    }

    const cm2 = rel.match(/^\/api\/job\/([^/]+)\/cancel$/)
    if (cm2 && method === 'POST') {
      const id = cm2[1]
      if (!ID_RE.test(id)) return fail('bad id', 400)
      CANCELLED.add(id)
      await jobPatch(id, { status: 'cancelled', endedAt: Date.now() })
      await jobLog(id, 'warn', '已中断（用户手动）')
      const meta = await metaOf(id)
      if (meta) {
        meta.status = (meta.sections && meta.sections.some((x) => x.status === 'ok')) ? 'partial' : 'failed'
        await writeJson(join(CONTENT, id, 'meta.json'), meta)
      }
      return json({ ok: true })
    }

    const jm = rel.match(/^\/api\/job\/([^/]+)(?:\/instruction)?$/)
    if (jm) {
      const id = jm[1]
      if (!ID_RE.test(id)) return fail('bad id', 400)
      const isInstruction = rel.endsWith('/instruction')
      const job = await jobGet(id)
      if (method === 'GET' && !isInstruction) return json(job || { status: 'idle', logs: [] })
      if (method === 'POST' && isInstruction) {
        const body = await request.json().catch(() => null)
        const text = String((body && body.text) || '').trim().slice(0, 500)
        if (!text) return fail('指令不能为空')
        CANCELLED.delete(id)
        const busy = await jobGet(id)
        if (busy && busy.status === 'running' && Date.now() - (busy.updatedAt || busy.startedAt || 0) < 15 * 60 * 1000) {
          return fail('这篇论文还有任务在运行，请等它结束再发指令', 409)
        }
        const meta = await metaOf(id)
        if (!meta) return fail('not found', 404)
        let secs = (await readJson(join(CONTENT, id, 'sections.json'), [])) || []
        let legacy = false
        if (!secs.length && Array.isArray(meta.sections) && meta.sections.length) {
          // 旧论文没有分节缓存：从 meta 重建（只能整篇重译）
          secs = meta.sections.map((x) => ({ id: x.id, title: x.title, level: x.level || 2, source: x.text || '', html: '', ok: true }))
          await writeJson(join(CONTENT, id, 'sections.json'), secs)
          legacy = true
        }
        if (!secs.length) return fail('这篇论文还没有可重译的章节')
        const fullReingest = /重新解析|重新提取|补全信息|补全元|重新上传/.test(text)
        if (fullReingest) {
          const oldJob = await jobGet(id)
          const keep2 = ((oldJob && oldJob.logs) || []).slice(-80)
          await writeJson(jobFile(id), { paperId: id, status: 'running', startedAt: Date.now(), instruction: text, runs: ((oldJob && oldJob.runs) || 1) + 1, logs: keep2 })
          await jobLog(id, 'info', '收到指令：' + text)
          await jobLog(id, 'info', '重新解析 PDF、重建配图并补全元信息')
          meta.status = 'processing'
          await writeJson(join(CONTENT, id, 'meta.json'), meta)
          processUpload(ctx, id, {}).catch((e) => {
            console.error('[paper-reader] reingest failed:', e)
            jobLog(id, 'error', '任务异常：' + errText(e)).catch(() => {})
            jobPatch(id, { status: 'failed', endedAt: Date.now() }).catch(() => {})
          })
          return json({ ok: true, sections: ['full-reingest'] })
        }

        // 让模型把自然语言要求解析成动作，再逐条执行
        const prevJob = await jobGet(id)
        const keepLogs = ((prevJob && prevJob.logs) || []).slice(-80)
        await writeJson(jobFile(id), { paperId: id, status: 'running', startedAt: Date.now(), instruction: text, runs: ((prevJob && prevJob.runs) || 1) + 1, logs: keepLogs })
        await jobLog(id, 'info', '收到指令：' + text)
        meta.status = 'processing'
        await writeJson(join(CONTENT, id, 'meta.json'), meta)
        ;(async () => {
          try {
            await agentLoop(ctx, id, text)
            const m2 = await readJson(join(CONTENT, id, 'meta.json'), {})
            m2.status = 'ready'
            await writeJson(join(CONTENT, id, 'meta.json'), m2)
            await jobLog(id, 'ok', '指令执行完成')
            await jobPatch(id, { status: 'done', endedAt: Date.now() })
          } catch (e) {
            await jobLog(id, 'error', '指令执行失败：' + errText(e))
            await jobPatch(id, { status: 'failed', endedAt: Date.now() })
          }
        })()
        return json({ ok: true, planned: true })
      }
      return fail('not found', 404)
    }

    if (rel === '/api/ask' && method === 'POST') {
      const body = await request.json().catch(() => null)
      if (!body || !body.paperId || !body.question) return fail('缺少参数', 400)
      const meta = await metaOf(body.paperId)
      if (!meta) return fail('not found', 404)
      const answer = await streamText(ctx, buildMessages(meta, body.sectionTitle, body.sectionText, body.question))
      const entry = { id: 'qa-' + Date.now(), anchor: body.anchor || 'root', sectionTitle: body.sectionTitle || '', q: body.question, a: answer, ts: Date.now(), by: 'DeepSeek' }
      await addQa(body.paperId, entry)
      return json({ answer, entry })
    }
    if (rel.startsWith('/api/qa/') && method === 'GET') {
      const id = rel.slice('/api/qa/'.length)
      if (!ID_RE.test(id)) return fail('bad id', 400)
      return json(await qaOf(id))
    }

    return fail('not found', 404)
  } catch (err) {
    ctx.logger && ctx.logger.warn && ctx.logger.warn(err)
    return json({ error: String((err && err.message) || err) }, 500)
  }
}

export default { name, inject, apply }
