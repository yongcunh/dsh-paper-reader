/* 论文阅读框架前端 —— 纯原生 JS */
(function () {
  'use strict';

  var API = '/paper-reader/api';
  var EMBED = /[?&]chrome=1/.test(location.search);
  if (EMBED) document.body.classList.add('chrome');

  function postState() {
    if (!EMBED) return;
    try {
      window.parent.postMessage({
        source: 'pr-app', type: 'state',
        collections: (state.collections || []).map(function (c) { return { id: c.id, name: c.name, fixed: !!c.fixed }; }),
        active: state.collection,
        job: state.job ? state.job.status : null,
        dark: document.documentElement.dataset.theme === 'dark',
        processing: !!(state.paper && state.paper.meta && state.paper.meta.status === 'processing')
      }, '*');
    } catch (e) {}
  }

  var state = {
    sysLogAfter: 0,
    sysLogTimer: null,
    logTab: 'job',
    papers: [],
    collections: [],
    collection: 'all',
    query: '',
    paper: null,          // {meta, qa}
    tab: 'zh',
    currentSection: null,
    pollTimer: null
  };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var modalResolve = null;
  function askText(title, value) {
    return new Promise(function (resolve) {
      modalResolve = resolve;
      $('#modal-title').textContent = title;
      var inp = $('#modal-input');
      inp.value = value || '';
      $('#modal').hidden = false;
      setTimeout(function () { inp.focus(); inp.select(); }, 30);
    });
  }
  function closeModal(v) {
    var r = modalResolve;
    modalResolve = null;
    $('#modal').hidden = true;
    if (r) r(v);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 是否嵌在 DSH 面板里；macOS 桌面需要给红绿灯留出左侧安全区
  // 嵌入 DSH 面板时，和父页面同源：直接读侧栏宽度，动态给红绿灯留位。
  // macOS 红绿灯右边缘约 84px；侧栏展开时面板本来就右移，无需缩进。
  // 嵌入 DSH 面板时读取父页面：侧栏宽度 + 顶部浮层（红绿灯外的按钮组）右缘，
  // 动态给阅读器顶栏留出安全区；侧栏展开时浮层落在侧栏上，缩进自动归零。
  function syncEmbedInsets() {
    if (window.self === window.top) return;
    var mac = /Mac/i.test(navigator.platform || '') || /Macintosh/i.test(navigator.userAgent || '');
    var w = 0, seatRight = 0, known = false;
    try {
      var pd = window.parent.document;
      var col = pd.querySelector("[class*='_sidebarCol']");
      w = col ? col.getBoundingClientRect().width : 0;
      var seat = pd.querySelector("[class*='_leadingSeat']");
      seatRight = seat ? seat.getBoundingClientRect().right : 0;
      known = true;
    } catch (e) { /* cross-origin: fall back below */ }
    if (!known) {
      var q = new URLSearchParams(location.search);
      w = q.get('embed') === 'darwin' ? 56 : 0;
      seatRight = 152;
    }
    var collapsed = w < 120;
    var pad = 0;
    var hasChrome = /[?&]chrome=1/.test(location.search);
    if (mac && collapsed && !hasChrome) {
      // 顶部浮层（侧栏开关等）压在面板上时，让标题从它右侧开始
      if (seatRight > w) pad = Math.round(seatRight - w) + 10;
      if (!pad) pad = Math.max(0, 152 - Math.round(w)) + 10;
    }
    var top = document.querySelector('.top');
    if (top) top.style.paddingLeft = pad ? pad + 'px' : '';
    document.body.classList.toggle('embed-mac', mac);
    document.body.classList.toggle('rail-collapsed', collapsed);
  }

  function renderMath(root) {
    if (!window.renderMathInElement || !window.katex) return;
    try {
      window.renderMathInElement(root, {
        delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        throwOnError: false
      });
    } catch (e) { console.warn('katex', e); }
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; }
  }
  async function api(path, opts) {
    var res = await fetch(API + path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  /* ---------------- 顶栏 / 分区 ---------------- */

  function collectionName(id) {
    var c = state.collections.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : 'Draft';
  }

  function renderCollections() {
    var box = $('#collections');
    box.innerHTML = '';
    var counts = {};
    state.papers.forEach(function (p) { counts[p.collectionId] = (counts[p.collectionId] || 0) + 1; });

    // 新增分区按钮放在最左边
    var add = document.createElement('button');
    add.className = 'col-tab col-add';
    add.textContent = '＋';
    add.title = '新建分区';
    add.onclick = newCollection;
    box.appendChild(add);

    var mk = function (id, name, fixed) {
      var b = document.createElement('button');
      b.className = 'col-tab' + (state.collection === id ? ' active' : '') + (fixed ? ' fixed' : '');
      var label = document.createElement('span');
      label.textContent = name;
      b.appendChild(label);
      var n = (id === 'all') ? state.papers.length : (counts[id] || 0);
      var cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = n;
      b.appendChild(cnt);
      b.title = fixed ? '默认分区（不可改名/删除）' : '左键筛选，右键管理';
      b.onclick = function () { state.collection = id; renderCollections(); renderList(); postState(); };
      b.oncontextmenu = function (ev) {
        if (fixed) return;
        ev.preventDefault();
        var idx = state.collections.findIndex(function (c) { return c.id === id; });
        openMenu(ev.clientX, ev.clientY, [
          { label: '重命名分区', run: function () { renameCollection(id); } },
          { label: '左移', run: function () { moveCollection(id, 'up'); } },
          { label: '右移', run: function () { moveCollection(id, 'down'); } },
          { label: '删除分区（论文移入 Draft）', danger: true, run: function () { removeCollection(id); } }
        ]);
      };
      box.appendChild(b);
    };
    mk('all', '全部', true);
    state.collections.forEach(function (c) { mk(c.id, c.name, !!c.fixed); });
  }

  async function moveCollection(id, dir) {
    try {
      await api('/collections/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ move: dir }) });
      await loadLibrary();
    } catch (e) { alert('移动失败：' + e.message); }
  }

  async function newCollection() {
    var name = await askText('新建分区名称');
    if (!name || !name.trim()) return;
    try { await api('/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); await loadLibrary(); }
    catch (e) { alert('新建失败：' + e.message); }
  }
  async function renameCollection(id) {
    var name = await askText('新的分区名称', collectionName(id));
    if (!name || !name.trim()) return;
    try { await api('/collections/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); await loadLibrary(); }
    catch (e) { alert('重命名失败：' + e.message); }
  }
  async function removeCollection(id) {
    if (!confirm('删除分区「' + collectionName(id) + '」？其中的论文会移入 Draft。')) return;
    try {
      await api('/collections/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.collection === id) state.collection = 'all';
      await loadLibrary();
    } catch (e) { alert('删除失败：' + e.message); }
  }

  /* ---------------- 论文列表 ---------------- */

  async function loadLibrary() {
    var data = await api('/library');
    state.papers = data.papers || [];
    state.collections = data.collections || [];
    renderCollections();
    renderList();
    postState();
    var m = (location.hash || '').match(/^#p=([^&]+)(?:&s=([^&]+))?/);
    if (m && !state.paper) openPaper(decodeURIComponent(m[1]), m[2] ? decodeURIComponent(m[2]) : null);
  }

  function match(p, q) {
    if (!q) return true;
    q = q.toLowerCase();
    var hay = [p.title, p.titleZh, p.abstract, p.authors, p.venue]
      .concat((p.sections || []).map(function (s) { return s.title + ' ' + (s.text || ''); }))
      .join('\n').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function renderList() {
    var list = state.papers.filter(function (p) {
      return (state.collection === 'all' || p.collectionId === state.collection) && match(p, state.query);
    });
    var box = $('#lib-list');
    box.innerHTML = '';
    $('#lib-count').textContent = (state.collection === 'all' ? '全部论文' : collectionName(state.collection)) + ' · ' + list.length;
    if (!list.length) { box.innerHTML = '<div class="qa-empty">没有匹配的论文</div>'; return; }

    list.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'lib-item' + (state.paper && state.paper.meta.id === p.id ? ' active' : '');
      var status = p.status === 'processing' ? '<span class="st processing">翻译中…</span>'
        : p.status === 'failed' ? '<span class="st failed">处理失败</span>' : '';
      d.innerHTML = '<div class="t">' + esc(p.titleZh || p.title) + '</div>' +
        '<div class="s">' + (p.year ? '<span class="tag">' + esc(p.year) + '</span>' : '') +
        esc(p.authorsShort || p.venue || collectionName(p.collectionId)) + status + '</div>' +
        '<button class="item-menu" title="更多">⋯</button>';
      d.onclick = function () { openPaper(p.id); };
      d.querySelector('.item-menu').onclick = function (ev) {
        ev.stopPropagation();
        openMenu(ev.clientX, ev.clientY, [
          { label: '重命名', run: function () { renamePaper(p); } },
          { label: '移动到分区…', run: function () { movePaperMenu(p, ev.clientX, ev.clientY); } },
          { label: '删除论文', danger: true, run: function () { removePaper(p); } }
        ]);
      };
      box.appendChild(d);
    });
  }

  async function renamePaper(p) {
    var name = await askText('新的中文标题', p.titleZh || p.title);
    if (!name || !name.trim()) return;
    try {
      await api('/paper/' + encodeURIComponent(p.id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ titleZh: name.trim() }) });
      await loadLibrary();
      if (state.paper && state.paper.meta.id === p.id) openPaper(p.id);
    } catch (e) { alert('重命名失败：' + e.message); }
  }
  function movePaperMenu(p, x, y) {
    var items = state.collections.filter(function (c) { return c.id !== p.collectionId; }).map(function (c) {
      return { label: '移动到「' + c.name + '」', run: function () { movePaper(p, c.id); } };
    });
    if (!items.length) items = [{ label: '（没有其它分区）', run: function () {} }];
    openMenu(x, y, items);
  }
  async function movePaper(p, collectionId) {
    try {
      await api('/paper/' + encodeURIComponent(p.id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collectionId: collectionId }) });
      await loadLibrary();
    } catch (e) { alert('移动失败：' + e.message); }
  }
  async function removePaper(p) {
    if (!confirm('删除论文「' + (p.titleZh || p.title) + '」？内容与问答都会删除。')) return;
    try {
      await api('/paper/' + encodeURIComponent(p.id), { method: 'DELETE' });
      if (state.paper && state.paper.meta.id === p.id) { state.paper = null; $('#paper').hidden = true; $('#empty').hidden = false; }
      await loadLibrary();
    } catch (e) { alert('删除失败：' + e.message); }
  }

  /* ---------------- 上传 ---------------- */

  function bindUpload() {
    var btn = $('#upload-btn'), input = $('#upload-file');
    btn.onclick = function () { input.click(); };
    input.onchange = async function () {
      var file = input.files && input.files[0];
      if (!file) return;
      btn.disabled = true;
      btn.textContent = '上传中…';
      try {
        var col = state.collection === 'all' ? 'drafts' : state.collection;
        var url = API + '/upload?name=' + encodeURIComponent(file.name) + '&collection=' + encodeURIComponent(col);
        var res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: file });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || '上传失败');
        await loadLibrary();
        openPaper(data.id);
        toggleConsole(true);
        pollPaper(data.id);
      } catch (e) {
        alert('上传失败：' + e.message);
      } finally {
        input.value = '';
        btn.disabled = false;
        btn.textContent = '＋ 上传 PDF';
      }
    };
  }

  function pollPaper(id) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    var ticks = 0;
    state.pollTimer = setInterval(async function () {
      ticks++;
      try {
        var data = await api('/paper/' + encodeURIComponent(id));
        var p = state.papers.filter(function (x) { return x.id === id; })[0];
        if (p) { p.status = data.meta.status; p.titleZh = data.meta.titleZh; }
        renderList();
        if (state.paper && state.paper.meta.id === id && data.meta.status !== 'processing') {
          clearInterval(state.pollTimer); state.pollTimer = null;
          openPaper(id);
        }
      } catch (e) { /* ignore */ }
      if (ticks > 120) { clearInterval(state.pollTimer); state.pollTimer = null; }
    }, 3000);
  }

  /* ---------------- 论文 ---------------- */

  async function openPaper(id, jumpTo) {
    var data;
    try { data = await api('/paper/' + encodeURIComponent(id)); }
    catch (e) {
      $('#empty').hidden = false;
      $('#empty').innerHTML = '<div class="empty-mark">⚠</div><p>加载失败：' + esc(e.message) + '</p>';
      return;
    }
    data.meta.id = id;
    state.paper = data;
    state.tab = 'zh';
    state.currentSection = null;

    $('#empty').hidden = true;
    $('#paper').hidden = false;
    $('#p-title').textContent = data.meta.titleZh || data.meta.title || '';
    $('#p-title-en').textContent = data.meta.titleZh ? (data.meta.title || '') : '';
    var bits = [];
    if (data.meta.authors) bits.push(data.meta.authors);
    if (data.meta.venue) bits.push(data.meta.venue);
    if (data.meta.year && bits.join(' ').indexOf(data.meta.year) < 0) bits.push(data.meta.year);
    if (data.meta.status === 'processing') bits.push('（正在自动翻译…）');
    $('#p-meta').textContent = bits.join(' · ');

    var pdfTab = $('#tab-pdf');
    if (data.meta.hasPdf) { pdfTab.hidden = false; pdfTab.textContent = 'PDF'; }
    else if (data.meta.hasWeb) { pdfTab.hidden = false; pdfTab.textContent = '网页'; }
    else { pdfTab.hidden = true; }

    setTab('zh');
    var zh = await fetch(API + '/paper/' + encodeURIComponent(id) + '/zh').then(function (r) { return r.text(); });
    var doc = $('#doc');
    doc.innerHTML = zh;
    renderMath(doc);
    bindSectionClicks(doc);
    renderOutline(data.meta.sections || []);
    renderQa();
    $('#qa-badge').textContent = (data.qa || []).length;
    bindImageEdit();
    loadJob();
    if (data.meta.status === 'processing' && !state.consoleOpen) toggleConsole(true);
    postState();
    $('.pane').scrollTop = 0;
    renderList();
    try { history.replaceState(null, '', '#p=' + encodeURIComponent(id)); } catch (e) {}
    if (jumpTo) {
      var target = document.getElementById(jumpTo);
      if (target) { target.scrollIntoView({ block: 'start' }); var sec = sectionById(jumpTo); if (sec) selectSection(sec); }
    }
  }

  function setTab(tab) {
    if (!state.paper) return;
    if (tab === 'info') return;
    state.tab = tab;
    $$('#tabs .tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    $('#doc').hidden = tab !== 'zh';
    $('#qa-pane').hidden = tab !== 'qa';
    $('#pdf-pane').hidden = tab !== 'pdf';
    // 目录索引只在「中文」页显示
    $('#outline').hidden = tab !== 'zh';
    if (tab === 'pdf') {
      var meta = state.paper.meta;
      var pane = $('#pdf-pane');
      pane.classList.toggle('web', !meta.hasPdf && !!meta.hasWeb);
      var frame = $('#pdf-frame');
      var src;
      if (meta.hasPdf) src = API + '/paper/' + encodeURIComponent(meta.id) + '/pdf';
      else if (meta.webUrl) src = meta.webUrl;
      else src = API + '/paper/' + encodeURIComponent(meta.id) + '/web';
      if (frame.dataset.src !== src) { frame.src = src; frame.dataset.src = src; }
    }
  }

  function renderOutline(sections) {
    var box = $('#outline');
    box.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'o-title';
    head.innerHTML = '<span>目录</span>';
    var addBtn = document.createElement('button');
    addBtn.className = 'o-add';
    addBtn.textContent = '＋';
    addBtn.title = '新增一节';
    addBtn.onclick = addSection;
    head.appendChild(addBtn);
    box.appendChild(head);
    sections.forEach(function (s, idx) {
      var a = document.createElement('a');
      a.href = '#';
      a.textContent = s.title;
      if (s.level === 3) a.className = 'lv3';
      a.dataset.anchor = s.id;
      a.onclick = function (ev) {
        ev.preventDefault();
        var target = document.getElementById(s.id);
        if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); selectSection(s); }
      };
      a.oncontextmenu = function (ev) {
        ev.preventDefault();
        openMenu(ev.clientX, ev.clientY, [
          { label: '重命名本节', run: function () { renameSection(idx, s.title); } },
          { label: '上移本节', run: function () { sectionOp('move', { sectionIndex: idx, dir: 'up' }); } },
          { label: '下移本节', run: function () { sectionOp('move', { sectionIndex: idx, dir: 'down' }); } },
          { label: '删除本节', danger: true, run: function () { deleteSection(idx, s.title); } }
        ]);
      };
      box.appendChild(a);
    });
  }

  async function sectionOp(op, payload) {
    if (!state.paper) return;
    await api('/paper/' + encodeURIComponent(state.paper.meta.id) + '/section/' + op, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {})
    });
    await openPaper(state.paper.meta.id);
  }

  async function addSection() {
    var name = await askText('新章节标题', '新章节');
    if (!name || !name.trim()) return;
    try { await sectionOp('add', { title: name.trim(), at: (state.paper.meta.sections || []).length }); }
    catch (e) { alert('新增失败：' + e.message); }
  }
  async function renameSection(idx, oldTitle) {
    var name = await askText('章节标题', oldTitle);
    if (!name || !name.trim()) return;
    try { await sectionOp('rename', { sectionIndex: idx, title: name.trim() }); }
    catch (e) { alert('重命名失败：' + e.message); }
  }
  async function deleteSection(idx, title) {
    if (!confirm('删除章节「' + title + '」及其全部内容？')) return;
    try { await sectionOp('delete', { sectionIndex: idx }); }
    catch (e) { alert('删除失败：' + e.message); }
  }
  function sectionById(id) {
    if (!state.paper) return null;
    return (state.paper.meta.sections || []).filter(function (s) { return s.id === id; })[0] || null;
  }
  function selectSection(s) {
    state.currentSection = s;
    $$('#outline a').forEach(function (a) { a.classList.toggle('active', a.dataset.anchor === s.id); });
    $('#qa-ctx').innerHTML = '提问位置：<b>' + esc(s.title) + '</b>（将把该节原文作为上下文）';
  }
  function bindSectionClicks(doc) {
    $$('h2[id], h3[id]', doc).forEach(function (h) {
      h.style.cursor = 'pointer';
      h.title = '点击：以本节为上下文提问';
      h.addEventListener('click', function () {
        var s = sectionById(h.id) || { id: h.id, title: h.textContent.trim(), text: h.parentNode.textContent };
        selectSection(s);
        setTab('qa');
      });
    });
  }

  /* ---------------- 问答 ---------------- */

  function renderQa() {
    var list = $('#qa-list');
    var qa = (state.paper && state.paper.qa) || [];
    list.innerHTML = '';
    if (!qa.length) list.innerHTML = '<div class="qa-empty">还没有问答。选择章节后可直接向 DeepSeek 提问，回答会保存在该论文的问答库。</div>';
    qa.forEach(function (it) {
      var d = document.createElement('div');
      d.className = 'qa-item';
      d.innerHTML = '<div class="qi-head"><span>' + esc(it.sectionTitle || '') + '</span><span>' + esc(it.ts ? fmtDate(it.ts) : (it.builtin ? '内置问答' : '')) + '</span></div>' +
        '<div class="qi-q">Q：' + esc(it.q) + '</div>' +
        '<div class="qi-a">' + esc(it.a) + '</div>';
      list.appendChild(d);
      renderMath(d);
    });
    list.scrollTop = list.scrollHeight;
    $('#qa-badge').textContent = qa.length;
  }

  async function ask() {
    if (!state.paper) return;
    var input = $('#qa-input');
    var q = input.value.trim();
    if (!q) { input.focus(); return; }
    var btn = $('#qa-send');
    btn.disabled = true; btn.textContent = '思考中…';
    var thinking = document.createElement('div');
    thinking.className = 'qa-thinking';
    thinking.innerHTML = 'DeepSeek 正在作答<span class="dot">…</span>';
    $('#qa-list').appendChild(thinking);
    $('#qa-list').scrollTop = $('#qa-list').scrollHeight;
    var sec = state.currentSection;
    try {
      var data = await api('/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paperId: state.paper.meta.id,
          anchor: sec ? sec.id : 'root',
          sectionTitle: sec ? sec.title : '整篇论文',
          sectionText: sec ? sec.text : state.paper.meta.abstract,
          question: q
        })
      });
      state.paper.qa.push(data.entry);
      renderQa();
      input.value = '';
    } catch (e) {
      thinking.remove();
      var err = document.createElement('div');
      err.className = 'qa-thinking'; err.style.color = '#a33';
      err.textContent = '出错了：' + e.message;
      $('#qa-list').appendChild(err);
    } finally {
      btn.disabled = false; btn.textContent = '提问';
    }
  }

  /* ---------------- 主题 ---------------- */

  function preferredDark() {
    var saved = localStorage.getItem('pr-theme');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyTheme() {
    var dark = preferredDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    var b = $('#theme-btn');
    if (b) b.textContent = dark ? '☀️' : '🌙';
    postState();
  }

  /* ---------------- 模型选择 ---------------- */

  async function loadAgentMode () {
    try {
      var st = await api('/settings');
      $('#c-mode').value = (st && st.agentMode === 'expert') ? 'expert' : 'normal';
    } catch (e) { /* 忽略 */ }
  }

  async function setAgentMode (mode) {
    try {
      await api('/settings/mode', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: mode })
      });
      var tip = mode === 'expert' ? '专家模式：代理可执行命令、安装 Python 包' : '普通模式：只做内容编辑';
      if (window.__toast) window.__toast(tip);
    } catch (e) { alert('切换模式失败：' + e.message); }
  }

  async function loadModels() {
    var sel = $('#c-model');
    if (!sel) return;
    try {
      var d = await api('/models');
      sel.innerHTML = '';
      var cur = d.current || {};
      var any = false;
      (d.providers || []).forEach(function (p) {
        var models = (p.models && p.models.length) ? p.models : [];
        models.forEach(function (m) {
          any = true;
          var o = document.createElement('option');
          o.value = p.id + '|' + m.id;
          o.textContent = p.id + ' / ' + (m.name || m.id);
          if (p.id === cur.provider && m.id === cur.model) o.selected = true;
          sel.appendChild(o);
        });
      });
      if (!any) {
        var o2 = document.createElement('option');
        o2.value = '';
        o2.textContent = '（没有可用模型，检查 DSH 模型配置）';
        sel.appendChild(o2);
      }
    } catch (e) {
      sel.innerHTML = '<option value="">（模型列表加载失败）</option>';
    }
  }

  async function applyModel() {
    var sel = $('#c-model');
    var v = (sel.value || '').split('|');
    if (v.length < 2 || !v[0]) return;
    try {
      await api('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: v[0], model: v[1] }) });
      if (state.job) await loadJob();
      alert('已切换模型：' + v[0] + ' / ' + v[1] + '\n下次翻译或重译时生效。');
    } catch (e) { alert('切换失败：' + e.message); }
  }

  /* ---------------- 运行日志 / 指令 ---------------- */

  function jobLabel(st) {
    return ({ running: '运行中…', done: '已完成', partial: '部分失败', failed: '失败', cancelled: '已中断', idle: '空闲' })[st] || st || '空闲';
  }
  function fmtTime(ts) {
    try { return new Date(ts).toTimeString().slice(0, 8); } catch (e) { return ''; }
  }
  function renderJob() {
    var job = state.job;
    var st = (job && job.status) || 'idle';
    var dot = $('#job-dot');
    if (dot) dot.className = 'dot ' + st;
    var stEl = $('#c-status');
    if (stEl) stEl.textContent = job ? (jobLabel(st) + (job.logs ? ' · ' + job.logs.length + ' 条' : '')) : '空闲';
    var cancelBtn = $('#c-cancel');
    if (cancelBtn) cancelBtn.hidden = !(job && job.status === 'running');
    var box = $('#c-log');
    if (!box) return;
    if (!job || !job.logs || !job.logs.length) {
      box.innerHTML = '<div class="log-line info"><span class="t"></span><span class="m">暂无日志。上传 PDF 或发送指令后会在这里显示过程。</span></div>';
      return;
    }
    box.innerHTML = job.logs.map(function (l) {
      return '<div class="log-line ' + (l.level || 'info') + '"><span class="t">' + fmtTime(l.ts) + '</span><span class="m">' + esc(l.text) + '</span></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
  async function loadJob() {
    if (!state.paper) { state.job = null; renderJob(); return; }
    try { state.job = await api('/job/' + encodeURIComponent(state.paper.meta.id)); }
    catch (e) { state.job = null; }
    renderJob();
    postState();
  }
  function toggleConsole(open) {
    state.consoleOpen = (open === undefined) ? !state.consoleOpen : !!open;
    var box = $('#console');
    if (box) box.hidden = !state.consoleOpen;
    document.body.classList.toggle('console-open', state.consoleOpen);
    if (state.consoleOpen) {
      loadAgentMode();
      loadModels();
      loadJob();
      postState();
      switchLogTab(state.logTab || 'job');
      var log = $('#c-log'); if (log) log.scrollTop = log.scrollHeight;
    } else {
      stopSysLogPoll();
    }
  }
  async function sendInstruction() {
    if (!state.paper) { alert('先打开一篇论文'); return; }
    var inp = $('#c-input');
    var text = inp.value.trim();
    if (!text) { inp.focus(); return; }
    var btn = $('#c-send');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      await api('/job/' + encodeURIComponent(state.paper.meta.id) + '/instruction', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text })
      });
      inp.value = '';
      if (!state.consoleOpen) toggleConsole(true);
      await loadJob();
    } catch (e) {
      alert('指令发送失败：' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '发送指令';
    }
  }

  /* ---------------- 系统日志 ---------------- */

  var SYS_LEVEL = { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' };

  function fmtTime (ts) {
    var d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  function renderSysEntries (entries) {
    var box = $('#c-sys');
    if (!entries.length) return;
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    entries.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'c-sys-row ' + (e.level || 'info');
      row.innerHTML = '<span class="t">' + fmtTime(e.ts) + '</span>' +
        '<span class="lv">' + (SYS_LEVEL[e.level] || 'INFO') + '</span>' +
        '<span class="msg"></span>';
      row.querySelector('.msg').textContent = e.text;
      box.appendChild(row);
    });
    while (box.childElementCount > 800) box.removeChild(box.firstElementChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  async function pollSysLog (force) {
    if (state.logTab !== 'sys' && !force) return;
    try {
      var r = await api('/logs?after=' + state.sysLogAfter);
      if (r && r.entries && r.entries.length) {
        state.sysLogAfter = r.now || state.sysLogAfter;
        renderSysEntries(r.entries);
      }
    } catch (e) { /* 忽略轮询错误 */ }
  }

  function startSysLogPoll () {
    if (state.sysLogTimer) return;
    state.sysLogTimer = setInterval(function () { pollSysLog(false); }, 2000);
  }
  function stopSysLogPoll () {
    if (state.sysLogTimer) { clearInterval(state.sysLogTimer); state.sysLogTimer = null; }
  }

  function switchLogTab (tab) {
    state.logTab = tab;
    $('#c-tab-job').classList.toggle('active', tab === 'job');
    $('#c-tab-sys').classList.toggle('active', tab === 'sys');
    $('#c-log').hidden = tab !== 'job';
    $('#c-sys').hidden = tab !== 'sys';
    $('#c-sys-clear').hidden = tab !== 'sys';
    if (tab === 'sys') { startSysLogPoll(); pollSysLog(true); }
    else stopSysLogPoll();
  }

  /* ---------------- 正文按块编辑 ---------------- */

  var BLOCK_SEL = 'p,table,ul,ol,pre,blockquote,figure';

  function blockIndexOfNode(node) {
    var n = 0, el = node;
    while (el && el !== document.body && !(el.id && /^sec-/.test(el.id))) {
      var prev = el.previousElementSibling;
      while (prev) {
        if (prev.id && /^sec-/.test(prev.id)) break;
        if (BLOCK_SEL.split(',').indexOf(prev.tagName.toLowerCase()) >= 0) n++;
        prev = prev.previousElementSibling;
      }
      el = el.parentElement;
    }
    return n;
  }

  function blockAt(node) {
    var el = node;
    while (el && el !== document.body) {
      if (el.parentElement === $('#doc') && BLOCK_SEL.split(',').indexOf(el.tagName.toLowerCase()) >= 0) return el;
      el = el.parentElement;
    }
    return null;
  }

  function placeTools(el) {
    var tools = $('#block-tools');
    if (!el) { tools.hidden = true; return; }
    var r = el.getBoundingClientRect();
    tools.hidden = false;
    tools.style.left = Math.max(8, Math.min(window.innerWidth - 300, r.right - 250)) + 'px';
    var top = r.top - 38;
    if (top < 8) top = Math.min(window.innerHeight - 40, r.bottom + 6);
    tools.style.top = top + 'px';
    state.editEl = el;
    state.editSection = sectionIndexOfNode(el);
    state.editBlock = blockIndexOfNode(el);
  }

  function toggleTextEdit() {
    state.textEdit = !state.textEdit;
    document.body.classList.toggle('text-edit', state.textEdit);
    $('#edit-text').classList.toggle('active', state.textEdit);
    setBlocksDraggable();
    if (!state.textEdit) $('#block-tools').hidden = true;
  }

  async function blockOp(op, payload) {
    if (!state.paper) return null;
    return api('/paper/' + encodeURIComponent(state.paper.meta.id) + '/block/' + op, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function blockAction(act) {
    var si = state.editSection, bi = state.editBlock;
    if (si == null || bi == null || si < 0) return;
    if (act === 'edit') { openBlockEditor(); return; }
    if (act === 'up' || act === 'down') {
      try { await blockOp('move', { sectionIndex: si, blockIndex: bi, dir: act }); await reloadDoc(); }
      catch (e) { alert('移动失败：' + e.message); }
      return;
    }
    if (act === 'img-above' || act === 'img-below') {
      openCrop('insertAt', { sectionIndex: si, blockIndex: state.editBlock + (act === 'img-below' ? 1 : 0) });
      $('#block-tools').hidden = true;
      return;
    }
    if (act === 'add') {
      try { await blockOp('insert', { sectionIndex: si, blockIndex: bi, html: '<p>新段落</p>' }); await reloadDoc(); }
      catch (e) { alert('新增失败：' + e.message); }
      return;
    }
    if (act === 'del') {
      if (!confirm('删除这一段？')) return;
      try { await blockOp('delete', { sectionIndex: si, blockIndex: bi }); await reloadDoc(); }
      catch (e) { alert('删除失败：' + e.message); }
    }
  }

  function openBlockEditor() {
    var el = state.editEl;
    if (!el) return;
    $('#block-tools').hidden = true;
    $('#block-text').value = el.innerHTML.trim();
    $('#block-modal').hidden = false;
    setTimeout(function () { $('#block-text').focus(); }, 30);
  }

  async function saveBlock() {
    var html = $('#block-text').value.trim();
    if (!html) { alert('内容不能为空，要删除请用「删除」'); return; }
    try {
      await blockOp('update', { sectionIndex: state.editSection, blockIndex: state.editBlock, html: html });
      $('#block-modal').hidden = true;
      await reloadDoc();
    } catch (e) { alert('保存失败：' + e.message); }
  }

  function clearDropMarks() {
    $$('#doc .drop-before, #doc .drop-after').forEach(function (el) {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  function setBlocksDraggable() {
    $$('#doc > *').forEach(function (el) {
      var tag = el.tagName.toLowerCase();
      if (['p', 'table', 'ul', 'ol', 'pre', 'blockquote', 'figure'].indexOf(tag) >= 0) {
        el.draggable = !!state.textEdit;
      }
    });
  }

  function bindBlockDrag() {
    var doc = $('#doc');
    doc.addEventListener('dragstart', function (ev) {
      if (!state.textEdit) return;
      var el = blockAt(ev.target);
      if (!el) return;
      state.dragSrc = { sectionIndex: sectionIndexOfNode(el), blockIndex: blockIndexOfNode(el) };
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', 'block');
      el.classList.add('dragging');
    });
    doc.addEventListener('dragend', function () {
      $$('#doc .dragging').forEach(function (el) { el.classList.remove('dragging'); });
      clearDropMarks();
      state.dragSrc = null;
    });
    doc.addEventListener('dragover', function (ev) {
      if (!state.dragSrc) return;
      var t = ev.target.closest('#doc > p, #doc > table, #doc > ul, #doc > ol, #doc > pre, #doc > blockquote, #doc > figure, #doc > h2[id], #doc > h3[id]');
      if (!t) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      var r = t.getBoundingClientRect();
      var isHead = /^h[23]$/i.test(t.tagName);
      var pos = (!isHead && (ev.clientY - r.top) > r.height / 2) ? 'after' : 'before';
      t.classList.add(pos === 'before' ? 'drop-before' : 'drop-after');
      state.dropTarget = { el: t, position: pos, isHead: isHead };
    });
    doc.addEventListener('drop', async function (ev) {
      if (!state.dragSrc || !state.dropTarget) return;
      ev.preventDefault();
      var t = state.dropTarget.el;
      var to = {
        sectionIndex: sectionIndexOfNode(t),
        blockIndex: state.dropTarget.isHead ? 0 : blockIndexOfNode(t),
        position: state.dropTarget.isHead ? 'before' : state.dropTarget.position
      };
      try {
        await api('/paper/' + encodeURIComponent(state.paper.meta.id) + '/block/reorder', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: state.dragSrc, to: to })
        });
        await reloadDoc();
      } catch (e) { alert('拖动失败：' + e.message); }
      clearDropMarks();
      state.dragSrc = null;
      state.dropTarget = null;
    });
  }

  function bindTextEdit() {
    var doc = $('#doc');
    // 点击段落选中并固定工具条（不再用悬停，避免鼠标一移工具条就消失）
    doc.addEventListener('click', function (ev) {
      if (!state.textEdit || !$('#block-modal').hidden) return;
      if (ev.target.closest('a')) ev.preventDefault();
      var el = blockAt(ev.target);
      if (!el) return;
      ev.stopPropagation();
      placeTools(el);
    }, true);
    // 点击工具条本身不隐藏
    $('#block-tools').addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    // 点击其它地方隐藏；滚动时跟着重新定位
    document.addEventListener('click', function (ev) {
      if (!state.textEdit) return;
      if (ev.target.closest('#block-tools') || ev.target.closest('#block-modal')) return;
      if (ev.target.closest('#doc')) return;
      $('#block-tools').hidden = true;
      state.editEl = null;
    });
    $('.pane').addEventListener('scroll', function () {
      if (state.textEdit && state.editEl && !$('#block-tools').hidden) placeTools(state.editEl);
    });
  }

  /* ---------------- 手动图片编辑（只动图） ---------------- */

  function sectionOfNode(node) {
    var el = node;
    while (el && el !== document.body) {
      if (el.id && /^sec-/.test(el.id)) return el.id;
      var prev = el.previousElementSibling;
      while (prev) {
        if (prev.id && /^sec-/.test(prev.id)) return prev.id;
        var inner = prev.querySelector ? prev.querySelector('h2[id],h3[id]') : null;
        if (inner) return inner.id;
        prev = prev.previousElementSibling;
      }
      el = el.parentElement;
    }
    return '';
  }

  function sectionIndexOfNode(node) {
    var heads = $$('#doc h2[id], #doc h3[id]');
    var idx = -1;
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].compareDocumentPosition(node) & 4) idx = i;
    }
    return idx;
  }

  function reloadDoc() {
    return fetch(API + '/paper/' + encodeURIComponent(state.paper.meta.id) + '/zh')
      .then(function (r) { return r.text(); })
      .then(function (zh) {
        $('#doc').innerHTML = zh;
        renderMath($('#doc'));
        bindSectionClicks($('#doc'));
        bindImageEdit();
        setBlocksDraggable();
        if (state.textEdit) { $('#block-tools').hidden = true; state.editEl = null; }
      });
  }

  function blockIndexOfParagraph(p) {
    var n = 0, el = p;
    while (el && !(el.id && /^sec-/.test(el.id))) {
      var prev = el.previousElementSibling;
      while (prev) { if (prev.tagName === 'P') n++; prev = prev.previousElementSibling; }
      el = el.parentElement;
    }
    return n;
  }

  function startPlace(mode, opts) {
    state.place = { mode: mode, src: opts.src, fromSectionIndex: opts.fromSectionIndex, sectionIndex: opts.sectionIndex };
    document.body.classList.add('placing');
    $('#place-bar').hidden = false;
    $('#place-bar .place-tip').textContent = mode === 'move'
      ? '点击一个段落：把这张图移到它前面'
      : '点击正文段落：图片会插入到该段之前';
  }

  function stopPlace() {
    state.place = null;
    document.body.classList.remove('placing');
    $('#place-bar').hidden = true;
  }

  async function commitPlace(sectionIndex, blockIndex) {
    if (!state.place || !state.paper) return;
    var id = state.paper.meta.id;
    try {
      if (state.place.mode === 'move') {
        await api('/paper/' + encodeURIComponent(id) + '/figure/move', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            fromSectionIndex: state.place.fromSectionIndex,
            toSectionIndex: sectionIndex,
            blockIndex: blockIndex,
            src: state.place.src
          })
        });
      } else {
        await api('/paper/' + encodeURIComponent(id) + '/figure/insert', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sectionIndex: sectionIndex, blockIndex: blockIndex, src: state.place.src })
        });
      }
      stopPlace();
      await reloadDoc();
    } catch (e) { alert('放置失败：' + e.message); }
  }

  function bindImageEdit() {
    if (!state.imageEdit) return;
    $$('#doc img').forEach(function (img) {
      img.onclick = function (ev) {
        ev.preventDefault();
        var sec = sectionOfNode(img);
        var sIdx = sectionIndexOfNode(img);
        openMenu(ev.clientX, ev.clientY, [
          { label: '删除这张图', danger: true, run: function () { deleteImage(sec, img.getAttribute('src'), sIdx); } },
          { label: '上移', run: function () { blockOp('move', { sectionIndex: sIdx, blockIndex: blockIndexOfNode(img), dir: 'up' }).then(reloadDoc).catch(function (e) { alert('移动失败：' + e.message); }); } },
          { label: '下移', run: function () { blockOp('move', { sectionIndex: sIdx, blockIndex: blockIndexOfNode(img), dir: 'down' }).then(reloadDoc).catch(function (e) { alert('移动失败：' + e.message); }); } },
          { label: '移动图片…', run: function () { startPlace('move', { src: img.getAttribute('src'), fromSectionIndex: sIdx, sectionIndex: sIdx }); } },
          { label: '重新框选裁剪', run: function () { openCrop('replace', { sectionId: sec, sectionIndex: sIdx, oldSrc: img.getAttribute('src') }); } }
        ]);
      };
    });
  }

  async function deleteImage(sectionId, src, sectionIndex) {
    if (!sectionId) { alert('找不到该图所在章节'); return; }
    if (!confirm('从正文中删除这张图？（不影响文字与公式）')) return;
    try {
      await api('/paper/' + encodeURIComponent(state.paper.meta.id) + '/figure/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sectionId: sectionId, sectionIndex: sectionIndex, src: src })
      });
      await reloadDoc();
    } catch (e) { alert('删除失败：' + e.message); }
  }

  function openCrop(mode, opts) {
    opts = opts || {};
    state.cropMode = mode;
    state.cropOldSrc = opts.oldSrc || '';
    state.cropSectionIndex = (opts.sectionIndex === undefined ? -1 : opts.sectionIndex);
    state.cropBlockIndex = (opts.blockIndex === undefined ? null : opts.blockIndex);
    var sel = $('#crop-section');
    sel.innerHTML = '';
    (state.paper.meta.sections || []).forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id; o.textContent = s.title;
      if (opts.sectionId === s.id) o.selected = true;
      sel.appendChild(o);
    });
    $('#crop-page').value = opts.page || 1;
    $('#crop-rect').hidden = true;
    $('#crop-modal').hidden = false;
    loadCropPage();
  }

  async function loadCropPage() {
    var page = Math.max(1, parseInt($('#crop-page').value || '1', 10));
    var img = $('#crop-img');
    img.onload = function () { $('#crop-tip').textContent = '在页面上拖动框选要截取的图片区域'; };
    img.src = API + '/paper/' + encodeURIComponent(state.paper.meta.id) + '/page-image/' + page;
  }

  function bindCropDrag() {
    var stage = $('#crop-stage'), rect = $('#crop-rect'), img = $('#crop-img');
    var start = null;
    stage.addEventListener('mousedown', function (ev) {
      if (ev.target !== img) return;
      var box = img.getBoundingClientRect();
      start = { x: ev.clientX - box.left, y: ev.clientY - box.top, box: box };
      rect.hidden = false;
      rect.style.left = (box.left - stage.getBoundingClientRect().left + stage.scrollLeft) + 'px';
      rect.style.top = (box.top - stage.getBoundingClientRect().top + stage.scrollTop) + 'px';
      rect.style.width = '0px'; rect.style.height = '0px';
      ev.preventDefault();
    });
    stage.addEventListener('mousemove', function (ev) {
      if (!start) return;
      var dx = ev.clientX - start.box.left - start.x;
      var dy = ev.clientY - start.box.top - start.y;
      var w = Math.abs(dx), h = Math.abs(dy);
      var left = Math.min(start.x, start.x + dx), top = Math.min(start.y, start.y + dy);
      rect.style.left = (start.box.left - stage.getBoundingClientRect().left + stage.scrollLeft + left) + 'px';
      rect.style.top = (start.box.top - stage.getBoundingClientRect().top + stage.scrollTop + top) + 'px';
      rect.style.width = w + 'px'; rect.style.height = h + 'px';
    });
    window.addEventListener('mouseup', function () {
      if (!start) return;
      var img = $('#crop-img');
      var r = rect.getBoundingClientRect();
      var box = img.getBoundingClientRect();
      var scale = img.naturalWidth / box.width;
      state.cropRect = {
        x: Math.round((r.left - box.left) * scale * (1 / 2)),
        y: Math.round((r.top - box.top) * scale * (1 / 2)),
        w: Math.round(r.width * scale * (1 / 2)),
        h: Math.round(r.height * scale * (1 / 2))
      };
      state.cropRectPx = { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
      $('#crop-tip').textContent = '已选区 ' + state.cropRect.w + ' × ' + state.cropRect.h + ' pt（约）';
      start = null;
    });
  }

  async function saveCrop() {
    if (!state.cropRect || state.cropRect.w < 10 || state.cropRect.h < 10) { alert('请先在页面上框选区域'); return; }
    var id = state.paper.meta.id;
    var sectionId = $('#crop-section').value;
    var page = Math.max(1, parseInt($('#crop-page').value || '1', 10));
    var btn = $('#crop-save'); btn.disabled = true; btn.textContent = '保存中…';
    try {
      var c = await api('/paper/' + encodeURIComponent(id) + '/figure/crop', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: page, x: state.cropRect.x, y: state.cropRect.y, w: state.cropRect.w, h: state.cropRect.h })
      });
      var src = '/paper-reader/api/paper/' + id + '/figures/' + c.file;
      var payload = { sectionId: sectionId, sectionIndex: $('#crop-section').selectedIndex, src: src, file: c.file };
      if (state.cropMode === 'insertAt') {
        var chosen = $('#crop-section').selectedIndex;
        var at = (chosen === state.cropSectionIndex) ? state.cropBlockIndex : -1;
        await api('/paper/' + encodeURIComponent(id) + '/figure/insert', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sectionIndex: chosen, blockIndex: at, src: src, file: c.file })
        });
        $('#crop-modal').hidden = true;
        state.cropRect = null;
        await reloadDoc();
        return;
      }
      if (state.cropMode === 'replace') { payload.oldSrc = state.cropOldSrc; }
      if (state.cropMode === 'insertAt') {
        var chosen = $('#crop-section').selectedIndex;
        var at = (chosen === state.cropSectionIndex) ? state.cropBlockIndex : -1;
        await api('/paper/' + encodeURIComponent(id) + '/figure/insert', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sectionIndex: chosen, blockIndex: at, src: src, file: c.file })
        });
        $('#crop-modal').hidden = true;
        state.cropRect = null;
        await reloadDoc();
        return;
      }
      if (state.cropMode === 'replace') {
        await api('/paper/' + encodeURIComponent(id) + '/figure/replace', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
        });
        $('#crop-modal').hidden = true;
        state.cropRect = null;
        await reloadDoc();
      } else {
        $('#crop-modal').hidden = true;
        state.cropRect = null;
        startPlace('insert', { src: src, sectionIndex: $('#crop-section').selectedIndex });
      }
    } catch (e) { alert('保存失败：' + e.message + '\n（裁剪与插入是两步，若已提示第一步成功，可重试或换个区域）'); }
    finally { btn.disabled = false; btn.textContent = '保存'; }
  }

  /* ---------------- 浮动菜单 ---------------- */

  function openMenu(x, y, items) {
    var menu = $('#ctx-menu');
    menu.innerHTML = '';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.className = 'danger';
      b.onclick = function () { closeMenu(); it.run(); };
      menu.appendChild(b);
    });
    menu.hidden = false;
    var w = 190;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 20 - items.length * 34) + 'px';
  }
  function closeMenu() { $('#ctx-menu').hidden = true; }

  /* ---------------- 事件 ---------------- */

  function bind() {
    $('#q').addEventListener('input', function (e) { state.query = e.target.value.trim(); renderList(); });
    $$('#tabs .tab').forEach(function (b) { b.onclick = function () { setTab(b.dataset.tab); }; });
    $('#paper-menu').onclick = function (ev) {
      if (!state.paper) return;
      var p = state.paper.meta;
      openMenu(ev.clientX, ev.clientY, [
        { label: '重命名', run: function () { renamePaper(p); } },
        { label: '移动到分区…', run: function () { movePaperMenu(p, ev.clientX, ev.clientY); } },
        { label: '删除论文', danger: true, run: function () { removePaper(p); } }
      ]);
    };
    $('#theme-btn').onclick = function () {
      var dark = document.documentElement.dataset.theme === 'dark';
      localStorage.setItem('pr-theme', dark ? 'light' : 'dark');
      applyTheme();
    };
    $('#modal-ok').onclick = function () { closeModal($('#modal-input').value.trim()); };
    $('#modal-cancel').onclick = function () { closeModal(null); };
    $('#modal-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); closeModal($('#modal-input').value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
    });
    $('#modal').addEventListener('click', function (e) { if (e.target === $('#modal')) closeModal(null); });
    $('#edit-text').onclick = toggleTextEdit;
    $('#block-tools').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-act]');
      if (b) { ev.preventDefault(); blockAction(b.getAttribute('data-act')); }
    });
    $('#c-tab-job').onclick = function () { switchLogTab('job'); };
    $('#c-tab-sys').onclick = function () { switchLogTab('sys'); };
    $('#c-sys-clear').onclick = function () { $('#c-sys').innerHTML = ''; };
    $('#block-save').onclick = saveBlock;
    $('#block-cancel').onclick = function () { $('#block-modal').hidden = true; };
    bindTextEdit();
    bindBlockDrag();
    $('#edit-figs').onclick = function () {
      state.imageEdit = !state.imageEdit;
      document.body.classList.toggle('image-edit', state.imageEdit);
      $('#edit-figs').classList.toggle('active', state.imageEdit);
      $('#add-fig').hidden = !state.imageEdit;
      bindImageEdit();
    };
    $('#add-fig').onclick = function () { openCrop('insert', { sectionId: (state.paper.meta.sections[0] || {}).id }); };
    $('#crop-cancel').onclick = function () { $('#crop-modal').hidden = true; };
    $('#place-cancel').onclick = stopPlace;
    $('#place-end').onclick = function () {
      if (!state.place) return;
      var idx = (state.place.sectionIndex >= 0) ? state.place.sectionIndex : state.place.fromSectionIndex;
      commitPlace(idx, -1);
    };
    $('#doc').addEventListener('click', function (ev) {
      if (!state.place) return;
      var p = ev.target.closest('#doc p');
      if (!p) return;
      ev.preventDefault();
      ev.stopPropagation();
      commitPlace(sectionIndexOfNode(p), blockIndexOfParagraph(p));
    }, true);
    $('#crop-cancel').onclick = function () { $('#crop-modal').hidden = true; };
    $('#crop-save').onclick = saveCrop;
    $('#crop-page').onchange = loadCropPage;
    bindCropDrag();
    $('#c-mode').onchange = function () { setAgentMode($('#c-mode').value); };
    $('#c-model-apply').onclick = applyModel;
    applyTheme();
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (!localStorage.getItem('pr-theme')) applyTheme();
      });
    }
    loadModels();
    $('#console-toggle').onclick = function () { toggleConsole(); };
    $('#c-close').onclick = function () { toggleConsole(false); };
    $('#c-reload').onclick = loadJob;
    $('#c-cancel').onclick = async function () {
      if (!state.paper) return;
      if (!confirm('中断当前任务？已完成的章节会保留。')) return;
      try {
        await api('/job/' + encodeURIComponent(state.paper.meta.id) + '/cancel', { method: 'POST' });
        await loadJob();
        await loadLibrary();
      } catch (e) { alert('中断失败：' + e.message); }
    };
    $('#c-send').onclick = sendInstruction;
    $$('#console .c-chips button').forEach(function (b) {
      b.onclick = function () {
        $('#c-input').value = b.getAttribute('data-cmd') || '';
        sendInstruction();
      };
    });
    $('#c-input').addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendInstruction(); }
    });
    setInterval(function () {
      if (!state.paper) return;
      var running = (state.job && state.job.status === 'running') || state.paper.meta.status === 'processing';
      if (state.consoleOpen || running) loadJob();
    }, 2500);
    $('#qa-send').onclick = ask;
    $('#qa-clear-ctx').onclick = function () {
      state.currentSection = null;
      $$('#outline a').forEach(function (a) { a.classList.remove('active'); });
      $('#qa-ctx').innerHTML = '提问位置：<b>整篇论文</b>';
    };
    $('#qa-input').addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ask(); }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (EMBED) { try { window.parent.postMessage({ source: 'pr-app', type: 'focus-search' }, '*'); } catch (err) {} }
        else $('#q').focus();
      }
      if (e.key === 'Escape') closeMenu();
    });
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#doc img')) return;
      if (!e.target.closest('#ctx-menu') && !e.target.closest('.item-menu')) closeMenu();
      var a = e.target.closest && e.target.closest('a[href]');
      if (a) {
        var href = a.getAttribute('href') || '';
        if (/^https?:/i.test(href) && href.indexOf(location.origin) !== 0) {
          e.preventDefault();
          window.open(href, '_blank', 'noopener');
        }
      }
    });
    syncEmbedInsets();
    setInterval(syncEmbedInsets, 400);
    window.addEventListener('resize', syncEmbedInsets);
    $('.pane').addEventListener('scroll', function () {
      if (state.tab !== 'zh') return;
      var heads = $$('#doc h2[id], #doc h3[id]');
      var cur = null;
      heads.forEach(function (h) { if (h.getBoundingClientRect().top < 240) cur = h; });
      if (cur && (!state.currentSection || state.currentSection.id !== cur.id)) {
        $$('#outline a').forEach(function (a) { a.classList.toggle('active', a.dataset.anchor === cur.id); });
      }
    });
  }

  if (EMBED) {
    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (!d || d.source !== 'pr-host') return;
      if (d.type === 'hello') { postState(); return; }
      if (d.type === 'search') { state.query = String(d.q || ''); renderList(); return; }
      if (d.type === 'collection') { state.collection = d.id || 'all'; renderCollections(); renderList(); postState(); return; }
      if (d.type === 'collection-add') {
        api('/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: d.name }) })
          .then(loadLibrary).then(postState).catch(function (e) { alert('新建失败：' + e.message) });
        return;
      }
      if (d.type === 'collection-rename') {
        api('/collections/' + encodeURIComponent(d.id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: d.name }) })
          .then(loadLibrary).then(postState).catch(function (e) { alert('重命名失败：' + e.message) });
        return;
      }
      if (d.type === 'collection-delete') {
        api('/collections/' + encodeURIComponent(d.id), { method: 'DELETE' })
          .then(function () { if (state.collection === d.id) state.collection = 'all'; return loadLibrary(); })
          .then(postState).catch(function (e) { alert('删除失败：' + e.message) });
        return;
      }
      if (d.type === 'refresh') {
        loadLibrary().then(function () { if (d.id) { openPaper(d.id); toggleConsole(true); pollPaper(d.id); } postState(); });
        return;
      }
      if (d.type === 'console') { toggleConsole(); postState(); return; }
      if (d.type === 'theme') {
        var isDark = document.documentElement.dataset.theme === 'dark';
        localStorage.setItem('pr-theme', isDark ? 'light' : 'dark');
        applyTheme(); postState();
        return;
      }
    });
  }

  bind();
  bindUpload();
  loadLibrary().catch(function (e) {
    document.body.innerHTML = '<pre style="padding:20px">加载失败：' + esc(e.message) + '</pre>';
  });
})();
