/* UI, часть 1: состояние, хранение, коллекция, редактор запроса, ответ, переменные, импорт/экспорт. */
(function () {
  'use strict';
  const A = window.ATA;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* ---------- DOM-хелперы ---------- */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach((x) => append(el, x));
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = msg; t.classList.remove('hide');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hide'), 2600);
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast((what || 'Текст') + ' скопирован'); }
    catch (e) {
      const ta = h('textarea', { value: text, style: 'position:fixed;left:-9999px' }); document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast((what || 'Текст') + ' скопирован'); } catch (e2) { toast('Не удалось скопировать'); }
      ta.remove();
    }
  }
  function download(name, data, type) {
    const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: type || 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const fileSafe = (s) => String(s || 'export').replace(/[^\wа-яё.-]+/gi, '_').slice(0, 60);
  const methodBadge = (m) => h('span', { class: 'm ' + m, text: m });
  const statusBadge = (code) => h('span', { class: 'badge ' + (typeof code !== 'number' ? 'fail' : code < 300 ? 'ok' : code < 400 ? 'info' : code < 500 ? 'warn' : 'fail'), text: String(code) });
  const isSecretKey = (v) => v.type === 'secret' || /token|secret|passw|api[-_]?key|private|auth|cookie/i.test(v.key || '');

  /* ---------- состояние ---------- */
  const S = {
    coll: A.normalizeCollection(A.newCollection('Новая коллекция')),
    envs: [{ name: 'Без окружения', values: [] }],
    envIdx: 0,
    selectedId: null, // null = настройки коллекции
    editorTab: 'headers',
    respTab: 'body',
    varTab: 'env',
    lastByItem: {},
    results: [],
    mocks: [],
    mockMode: false,
    settings: { timeout: 15000, slowMs: 2000, proxy: '', fallthrough: 'network' },
    spec: null, specText: '', specStrict: false,
    dataRows: null,
    globals: new Map(),
  };
  window.ATA_STATE = S; // для отладки из консоли

  const STORE = 'ata-state-v1';
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const envs = S.envs.map((e) => ({ name: e.name, values: e.values.map((v) => (isSecretKey(v) ? Object.assign({}, v, { value: '' }) : v)) }));
        localStorage.setItem(STORE, JSON.stringify({ coll: S.coll, envs, envIdx: S.envIdx, mocks: S.mocks, settings: S.settings, specText: S.specText.length < 2e6 ? S.specText : '', specStrict: S.specStrict, selectedId: S.selectedId }));
      } catch (e) { /* хранилище недоступно — работаем без него */ }
    }, 400);
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (d.coll) S.coll = A.normalizeCollection(d.coll);
      if (Array.isArray(d.envs) && d.envs.length) S.envs = d.envs;
      S.envIdx = Math.min(d.envIdx || 0, S.envs.length - 1);
      S.mocks = d.mocks || [];
      Object.assign(S.settings, d.settings || {});
      S.specStrict = !!d.specStrict;
      S.selectedId = d.selectedId || null;
      if (d.specText) { S.specText = d.specText; try { S.spec = JSON.parse(d.specText); } catch (e) { parseSpecText(d.specText).catch(() => {}); } }
      return true;
    } catch (e) { return false; }
  }

  const env = () => S.envs[S.envIdx];
  /** Map'ы для раннера; после прогона изменения пишем обратно в окружение/коллекцию. */
  function runtimeMaps() {
    const envMap = new Map(env().values.filter((v) => v.enabled !== false && v.key).map((v) => [v.key, v.value == null ? '' : String(v.value)]));
    const collMap = new Map((S.coll.variable || []).filter((v) => v.key && !v.disabled).map((v) => [v.key, v.value == null ? '' : String(v.value)]));
    return { envMap, collMap };
  }
  function syncBack(envMap, collMap) {
    const sync = (list, map, mk) => {
      for (const [k, v] of map) { const f = list.find((x) => x.key === k); if (f) f.value = v; else list.push(mk(k, v)); }
      for (let i = list.length - 1; i >= 0; i--) if (list[i].key && list[i].enabled !== false && !list[i].disabled && !map.has(list[i].key)) list.splice(i, 1);
    };
    sync(env().values, envMap, (key, value) => ({ key, value, type: 'default', enabled: true }));
    sync(S.coll.variable, collMap, (key, value) => ({ key, value }));
    renderVars(); save();
  }
  function sendOpts(extra) {
    return Object.assign({ timeout: Number(S.settings.timeout) || 15000, proxy: S.settings.proxy, mocks: S.mocks, mockMode: S.mockMode, mockFallthrough: S.settings.fallthrough, globals: S.globals }, extra || {});
  }
  function allTargets(filterFolderId) {
    const out = [];
    A.eachRequest(S.coll.item, (item, parents) => { if (!filterFolderId || parents.some((p) => p._id === filterFolderId)) out.push({ item, parents }); });
    return out;
  }

  /* ---------- шапка, вкладки, тема ---------- */
  function setTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('section.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
    try { localStorage.setItem('ata-tab', name); } catch (e) { /* ignore */ }
    const fn = window.ATA_UI && window.ATA_UI['onTab_' + name];
    fn && fn();
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });

  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
  }
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('ata-theme', next); } catch (e) { /* ignore */ }
  });

  function renderEnvSelect() {
    const sel = clear($('#envSelect'));
    S.envs.forEach((e, i) => sel.appendChild(h('option', { value: i, text: e.name })));
    sel.value = S.envIdx;
  }
  $('#envSelect').addEventListener('change', (e) => { S.envIdx = Number(e.target.value); renderVars(); save(); });

  function renderMockToggle() {
    const b = $('#mockToggle');
    b.classList.toggle('on', S.mockMode);
    b.textContent = S.mockMode ? 'Моки: ВКЛ (' + S.mocks.filter((m) => m.enabled).length + ')' : 'Моки: выкл';
    b.setAttribute('aria-pressed', S.mockMode);
  }
  $('#mockToggle').addEventListener('click', () => { S.mockMode = !S.mockMode; renderMockToggle(); toast(S.mockMode ? 'Моки включены: ответы подменяются правилами' : 'Моки выключены'); });

  /* ---------- дерево ---------- */
  function renderTree() {
    $('#collName').textContent = S.coll.info.name;
    const root = clear($('#tree'));
    const filter = ($('#treeFilter').value || '').toLowerCase();
    const matches = (it) => !filter || (it.name || '').toLowerCase().includes(filter) || A.urlRaw(it.request && it.request.url).toLowerCase().includes(filter);
    const anyMatch = (it) => (it.item ? it.item.some(anyMatch) : matches(it));
    const top = h('ul', { class: 'tree' });
    top.appendChild(h('li', {}, h('div', { class: 'node' + (S.selectedId === null ? ' sel' : ''), onclick: () => select(null) }, h('span', { text: '⚙︎' }), h('span', { class: 'nm', text: 'Настройки коллекции (auth, скрипты)' }))));
    const build = (items, ul) => items.filter(anyMatch).forEach((it) => {
      if (it.item) {
        const open = filter ? true : it._open !== false;
        const li = h('li', { class: 'folder' },
          h('div', { class: 'node' + (S.selectedId === it._id ? ' sel' : ''), onclick: (e) => { if (e.target.classList.contains('caret')) { it._open = !open; renderTree(); } else select(it._id); } },
            h('span', { class: 'caret', text: open ? '▾' : '▸', title: 'Свернуть/развернуть' }), h('span', { class: 'nm', text: it.name }), h('span', { class: 'hint', text: String(countReq(it)) })));
        if (open) { const sub = h('ul'); build(it.item, sub); li.appendChild(sub); }
        ul.appendChild(li);
      } else {
        const last = S.lastByItem[it._id];
        ul.appendChild(h('li', {}, h('div', { class: 'node' + (S.selectedId === it._id ? ' sel' : ''), onclick: () => select(it._id), title: A.urlRaw(it.request.url) },
          methodBadge(it.request.method), h('span', { class: 'nm', text: it.name }), last ? h('span', { class: 'dot ' + (last.pass ? 'ok' : 'fail'), title: last.pass ? 'Последний запуск: успешно' : 'Последний запуск: падение' }) : null)));
      }
    });
    build(S.coll.item, top);
    root.appendChild(top);
    if (!S.coll.item.length) root.appendChild(h('div', { class: 'empty' }, 'Коллекция пуста. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openImport(); } }, 'Импортируйте'), ' Postman-коллекцию или загрузите демо.'));
  }
  const countReq = (f) => (f.item || []).reduce((n, x) => n + (x.item ? countReq(x) : 1), 0);
  $('#treeFilter').addEventListener('input', renderTree);

  function select(id) {
    S.selectedId = id;
    renderTree(); renderEditor(); renderResponse(); save();
  }
  const selected = () => (S.selectedId ? A.findById(S.coll, S.selectedId) : null);

  function addNode(node) {
    const sel = selected();
    let list = S.coll.item;
    if (sel) list = sel.item.item ? sel.item.item : sel.parents.length ? sel.parents[sel.parents.length - 1].item : S.coll.item;
    list.push(node);
    select(node._id);
    onCollectionChanged();
  }
  $('#newReqBtn').addEventListener('click', () => addNode(A.newRequest('Новый запрос', 'GET', '{{baseUrl}}/')));
  $('#newFolderBtn').addEventListener('click', () => addNode({ _id: A.uid(), name: 'Новая папка', item: [] }));

  /** Обновить зависящие от коллекции списки на других вкладках. */
  function onCollectionChanged() {
    renderTree(); save(); updateFlowCount();
    window.ATA_UI && window.ATA_UI.refreshSelectors && window.ATA_UI.refreshSelectors();
  }

  /* ---------- редактор ---------- */
  function kvTable(list, opts) {
    opts = opts || {};
    const tbl = h('table', { class: 'kv' });
    const redraw = () => { const n = kvTable(list, opts); tbl.replaceWith(n); };
    list.forEach((row, i) => {
      const enabledKey = opts.enabledKey || 'disabled';
      const isOn = enabledKey === 'disabled' ? !row.disabled : row.enabled !== false;
      tbl.appendChild(h('tr', {},
        h('td', { style: 'width:24px' }, h('input', { type: 'checkbox', checked: isOn, title: 'Включено', onchange: (e) => { if (enabledKey === 'disabled') row.disabled = !e.target.checked; else row.enabled = e.target.checked; opts.onChange && opts.onChange(); } })),
        h('td', { class: 'k' }, h('input', { type: 'text', value: row.key || '', placeholder: opts.keyPh || 'ключ', 'aria-label': 'Ключ', oninput: (e) => { row.key = e.target.value; opts.onChange && opts.onChange(); } })),
        h('td', {}, h('input', { type: opts.secret && isSecretKey(row) && !row._show ? 'password' : 'text', value: row.value == null ? '' : row.value, placeholder: 'значение', oninput: (e) => { row.value = e.target.value; opts.onChange && opts.onChange(); } })),
        opts.secret ? h('td', { style: 'width:38px' }, h('button', { class: 'btn sm' + (isSecretKey(row) ? '' : ' not-secret'), title: isSecretKey(row) ? 'Секрет: не сохраняется в браузере и не экспортируется. Нажмите, чтобы ' + (row._show ? 'скрыть' : 'показать') + ' значение' : 'Отметить как секрет', text: isSecretKey(row) ? (row._show ? '🙈' : '🔒') : '🔓', onclick: () => { if (isSecretKey(row)) row._show = !row._show; else row.type = 'secret'; redraw(); } })) : null,
        h('td', { style: 'width:38px' }, h('button', { class: 'btn sm danger', title: 'Удалить', text: '×', onclick: () => { list.splice(i, 1); redraw(); opts.onChange && opts.onChange(); } }))));
    });
    tbl.appendChild(h('tr', {}, h('td', { colspan: 5 }, h('button', { class: 'btn sm', text: '+ добавить', onclick: () => { list.push(opts.enabledKey === 'enabled' ? { key: '', value: '', enabled: true, type: 'default' } : { key: '', value: '' }); redraw(); } }))));
    return tbl;
  }

  function subTabs(tabs, cur, onPick) {
    return h('div', { class: 'sub-tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', { class: id === cur ? 'active' : '', role: 'tab', text: label, onclick: () => onPick(id) })));
  }

  function authEditor(node) {
    const wrap = h('div');
    const isRoot = node === S.coll;
    const target = node.request || node;
    const draw = () => {
      clear(wrap);
      const auth = target.auth || { type: isRoot ? 'noauth' : 'inherit' };
      const sel = h('select', { onchange: (e) => { const t = e.target.value; target.auth = t === 'inherit' ? undefined : { type: t, [t]: [] }; if (t === 'inherit') delete target.auth; save(); draw(); } },
        (isRoot ? [] : [['inherit', 'Наследовать от родителя']]).concat([['noauth', 'Без авторизации'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key']]).map(([v, l]) => h('option', { value: v, text: l })));
      sel.value = auth.type || 'inherit';
      wrap.appendChild(h('label', { class: 'f' }, 'Тип', sel));
      const param = (key, label, ph) => {
        const list = (auth[auth.type] = Array.isArray(auth[auth.type]) ? auth[auth.type] : []);
        let p = list.find((x) => x.key === key);
        return h('label', { class: 'f', style: 'margin-top:6px' }, label, h('input', { type: 'text', value: p ? p.value : '', placeholder: ph || '', oninput: (e) => { if (!p) { p = { key, value: '', type: 'string' }; list.push(p); } p.value = e.target.value; save(); } }));
      };
      if (auth.type === 'bearer') wrap.appendChild(param('token', 'Токен', '{{token}}'));
      if (auth.type === 'basic') { wrap.appendChild(param('username', 'Логин', '{{username}}')); wrap.appendChild(param('password', 'Пароль', '{{password}}')); }
      if (auth.type === 'apikey') { wrap.appendChild(param('key', 'Имя', 'X-API-Key')); wrap.appendChild(param('value', 'Значение', '{{apiKey}}')); wrap.appendChild(param('in', 'Куда (header / query)', 'header')); }
      if (auth.type === 'inherit') {
        const f = selected();
        const eff = f ? A.effectiveAuth(S.coll, f.item, f.parents.filter((p) => p !== f.item)) : null;
        wrap.appendChild(h('p', { class: 'hint', text: 'Сейчас действует: ' + (eff ? eff.type : 'без авторизации') }));
      }
      wrap.appendChild(h('p', { class: 'hint', text: 'Храните токены в переменных окружения ({{token}}) — значения секретов не сохраняются в браузере и не экспортируются без явного выбора.' }));
    };
    draw();
    return wrap;
  }

  function scriptsEditor(node) {
    return h('div', {},
      h('label', { class: 'f' }, 'Pre-request (выполняется до запроса)', h('textarea', { class: 'code', spellcheck: 'false', value: A.scriptOf(node, 'prerequest'), oninput: (e) => { A.setScript(node, 'prerequest', e.target.value); save(); } })),
      h('label', { class: 'f', style: 'margin-top:8px' }, 'Tests (выполняются после ответа)', h('textarea', { class: 'code', id: 'testsArea', spellcheck: 'false', value: A.scriptOf(node, 'test'), oninput: (e) => { A.setScript(node, 'test', e.target.value); save(); } })),
      h('p', { class: 'hint' }, 'Поддерживается: pm.test, pm.expect (chai: equal, eql, include, property, oneOf, below, above, a/an, lengthOf, match, not…), pm.response.to.have.status/header/jsonBody/jsonSchema, pm.environment/collectionVariables/variables/iterationData, pm.execution.setNextRequest, pm.sendRequest (колбэк и await), асинхронные pm.test, console.log, legacy tests[]. Не поддерживается: require(), cookies — такие кейсы гоняйте через Newman / Postman CLI.'));
  }

  function checksEditor(node) {
    const wrap = h('div');
    const typeSel = h('select', {}, Object.entries(A.ASSERTION_TYPES).map(([k, t]) => h('option', { value: k, text: t.label })));
    const val = h('input', { type: 'text', class: 'grow', placeholder: A.ASSERTION_TYPES.status.ph });
    typeSel.addEventListener('change', () => { val.placeholder = A.ASSERTION_TYPES[typeSel.value].ph; val.disabled = !A.ASSERTION_TYPES[typeSel.value].ph; });
    const list = h('ul', { class: 'tests' });
    const drawList = () => {
      clear(list);
      const code = A.scriptOf(node, 'test');
      const names = Array.from(code.matchAll(/pm\.test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)).map((m) => m[2]);
      if (!names.length) list.appendChild(h('li', { class: 'hint', text: 'Проверок пока нет' }));
      const last = S.lastByItem[node._id];
      names.forEach((n) => {
        const t = last && last.tests.find((x) => x.name === n);
        list.appendChild(h('li', {}, t ? h('span', { class: 'badge ' + (t.pass ? 'ok' : 'fail'), text: t.pass ? 'OK' : 'FAIL' }) : h('span', { class: 'badge', text: '—' }), h('span', { text: n })));
      });
    };
    wrap.appendChild(h('div', { class: 'row' }, typeSel, val, h('button', { class: 'btn primary sm', text: 'Добавить проверку', onclick: () => {
      const t = A.ASSERTION_TYPES[typeSel.value];
      if (t.ph && !val.value.trim()) { val.value = t.ph; }
      const last = S.lastByItem[node._id];
      let code;
      try { code = t.code(val.value.trim(), last && last.response ? { json: last.response.json } : null); } catch (err) { toast(err.message); return; }
      const cur = A.scriptOf(node, 'test');
      A.setScript(node, 'test', (cur ? cur.replace(/\s+$/, '') + '\n\n' : '') + code);
      save(); drawList(); toast('Проверка добавлена в Tests');
    } })));
    wrap.appendChild(h('p', { class: 'hint', text: '«Совпадает со схемой» фиксирует структуру последнего ответа, «Совпадает с эталоном» — сами значения (через запятую укажите меняющиеся поля: id, createdAt). Проверки сохраняются как обычный код pm.test — коллекция остаётся совместимой с Postman.' }));
    wrap.appendChild(list);
    drawList();
    return wrap;
  }

  function bodyEditor(req) {
    const wrap = h('div');
    const draw = () => {
      clear(wrap);
      const b = req.body || { mode: 'none' };
      const lang = b.mode === 'raw' ? (b.options && b.options.raw && b.options.raw.language) || 'json' : '';
      const modeVal = b.mode === 'raw' ? 'raw-' + (lang === 'json' ? 'json' : 'text') : b.mode || 'none';
      const sel = h('select', { onchange: (e) => {
        const v = e.target.value;
        const prevRaw = b.raw || '';
        if (v === 'none') req.body = { mode: 'none' };
        else if (v === 'raw-json') req.body = { mode: 'raw', raw: prevRaw || '{\n  \n}', options: { raw: { language: 'json' } } };
        else if (v === 'raw-text') req.body = { mode: 'raw', raw: prevRaw, options: { raw: { language: 'text' } } };
        else if (v === 'urlencoded') req.body = { mode: 'urlencoded', urlencoded: b.urlencoded || [] };
        else if (v === 'formdata') req.body = { mode: 'formdata', formdata: b.formdata || [] };
        save(); draw();
      } }, [['none', 'Без тела'], ['raw-json', 'JSON'], ['raw-text', 'Текст / XML'], ['urlencoded', 'x-www-form-urlencoded'], ['formdata', 'form-data (текст)']].map(([v, l]) => h('option', { value: v, text: l })));
      sel.value = ['none', 'raw-json', 'raw-text', 'urlencoded', 'formdata'].includes(modeVal) ? modeVal : 'none';
      wrap.appendChild(h('div', { class: 'row' }, sel, b.mode === 'raw' && lang === 'json' ? h('button', { class: 'btn sm', text: 'Форматировать JSON', onclick: () => {
        try { b.raw = JSON.stringify(JSON.parse(b.raw), null, 2); save(); draw(); } catch (e) { toast('JSON невалиден: ' + e.message); }
      } }) : null, h('span', { class: 'hint', id: 'jsonState' })));
      if (b.mode === 'raw') {
        const ta = h('textarea', { class: 'code', spellcheck: 'false', value: b.raw || '', oninput: (e) => { b.raw = e.target.value; validateJson(); save(); } });
        const validateJson = () => {
          const st = $('#jsonState', wrap);
          if (lang !== 'json' || !st) return;
          const probe = (b.raw || '').replace(/\{\{[^}]+\}\}/g, '0');
          try { if (probe.trim()) JSON.parse(probe); st.textContent = probe.trim() ? '✓ JSON валиден' : ''; st.style.color = 'var(--ok)'; } catch (e) { st.textContent = '✗ ' + e.message; st.style.color = 'var(--fail)'; }
        };
        wrap.appendChild(ta);
        setTimeout(validateJson);
      } else if (b.mode === 'urlencoded') wrap.appendChild(kvTable(b.urlencoded, { onChange: save }));
      else if (b.mode === 'formdata') wrap.appendChild(kvTable(b.formdata, { onChange: save }));
      else wrap.appendChild(h('p', { class: 'hint', text: 'Запрос без тела.' }));
    };
    draw();
    return wrap;
  }

  function renderEditor() {
    const box = clear($('#editor'));
    const f = selected();
    if (!f) {
      box.appendChild(h('h2', { text: 'Настройки коллекции' }));
      box.appendChild(h('label', { class: 'f' }, 'Название', h('input', { type: 'text', value: S.coll.info.name, oninput: (e) => { S.coll.info.name = e.target.value; $('#collName').textContent = e.target.value; save(); } })));
      box.appendChild(subTabs([['auth', 'Авторизация'], ['scripts', 'Скрипты коллекции']], S.editorTab === 'scripts' ? 'scripts' : 'auth', (t) => { S.editorTab = t; renderEditor(); }));
      box.appendChild(S.editorTab === 'scripts' ? scriptsEditor(S.coll) : authEditor(S.coll));
      return;
    }
    const it = f.item;
    if (it.item) {
      box.appendChild(h('div', { class: 'row' }, h('h2', { text: 'Папка', style: 'margin:0' }), h('span', { style: 'flex:1' }),
        h('button', { class: 'btn sm', text: '▶ Запустить папку', onclick: () => window.ATA_UI.runFolder(it._id) }),
        h('button', { class: 'btn sm danger', text: 'Удалить', onclick: () => removeSelected() })));
      box.appendChild(h('label', { class: 'f', style: 'margin-top:8px' }, 'Название', h('input', { type: 'text', value: it.name, oninput: (e) => { it.name = e.target.value; onCollectionChanged(); } })));
      box.appendChild(subTabs([['auth', 'Авторизация'], ['scripts', 'Скрипты папки']], S.editorTab === 'scripts' ? 'scripts' : 'auth', (t) => { S.editorTab = t; renderEditor(); }));
      box.appendChild(S.editorTab === 'scripts' ? scriptsEditor(it) : authEditor(it));
      return;
    }
    const req = it.request;
    const methodSel = h('select', { onchange: (e) => { req.method = e.target.value; onCollectionChanged(); } }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => h('option', { value: m, text: m })));
    methodSel.value = req.method;
    const varLine = h('div', { class: 'varline' });
    const drawVars = () => {
      clear(varLine);
      const names = A.varNames(S.coll, it, f.parents);
      if (!names.length) return;
      const { envMap, collMap } = runtimeMaps();
      const dataKeys = S.dataRows && S.dataRows[0] ? Object.keys(S.dataRows[0]) : [];
      varLine.appendChild(h('span', { class: 'hint', text: 'Переменные:' }));
      names.forEach((n) => {
        const src = A.isDynamicVar(n) ? 'dyn' : envMap.has(n) ? 'env' : collMap.has(n) ? 'coll' : dataKeys.includes(n) ? 'data' : null;
        const val = src === 'env' ? envMap.get(n) : src === 'coll' ? collMap.get(n) : '';
        const secret = isSecretKey({ key: n, type: (env().values.find((v) => v.key === n) || {}).type });
        const title = src === 'dyn' ? 'Динамическая переменная Postman' : src === 'data' ? 'Из файла данных' : src ? (src === 'env' ? 'Окружение' : 'Коллекция') + ': ' + (secret ? '••••' : val) + (val === '' ? ' (пустое значение!)' : '') : 'Значение не задано — добавьте в окружение или переменные коллекции (либо его задаст скрипт предыдущего запроса)';
        varLine.appendChild(h('span', { class: 'badge ' + (src && val !== '' ? 'ok' : src === 'dyn' || src === 'data' ? 'info' : src ? 'warn' : 'fail'), title, text: (src && (val !== '' || src === 'dyn' || src === 'data') ? '✓ ' : '✗ ') + n }));
      });
    };
    let drawParams = () => {};
    const urlIn = h('input', { type: 'text', class: 'grow mono', value: A.urlRaw(req.url), placeholder: '{{baseUrl}}/path', 'aria-label': 'URL', oninput: (e) => { req.url = e.target.value; save(); drawVars(); drawParams(); }, onkeydown: (e) => { if (e.key === 'Enter') sendSelected(); } });
    box.appendChild(h('div', { class: 'row' }, h('input', { type: 'text', class: 'grow', value: it.name, 'aria-label': 'Название запроса', oninput: (e) => { it.name = e.target.value; onCollectionChanged(); } }),
      h('button', { class: 'btn sm', text: 'Дублировать', onclick: () => { const c = A.clone(it); c._id = A.uid(); c.name += ' (копия)'; f.list.splice(f.list.indexOf(it) + 1, 0, c); select(c._id); onCollectionChanged(); } }),
      h('button', { class: 'btn sm danger', text: 'Удалить', onclick: () => removeSelected() })));
    box.appendChild(h('div', { class: 'row', style: 'margin-top:8px' }, methodSel, urlIn, h('button', { class: 'btn primary', id: 'sendBtn', text: 'Отправить', title: 'Enter в строке URL или ⌘/Ctrl+Enter', onclick: sendSelected })));
    box.appendChild(varLine);
    drawVars();
    const nParams = A.splitQuery(A.urlRaw(req.url)).params.length;
    const tabs = [['params', 'Params' + (nParams ? ' (' + nParams + ')' : '')], ['headers', 'Заголовки (' + (req.header || []).filter((x) => !x.disabled && x.key).length + ')'], ['body', 'Тело'], ['auth', 'Auth'], ['checks', 'Проверки'], ['scripts', 'Скрипты']];
    const cur = tabs.some(([id]) => id === S.editorTab) ? S.editorTab : 'headers';
    box.appendChild(subTabs(tabs, cur, (t) => { S.editorTab = t; renderEditor(); }));
    if (cur === 'params') {
      const pbox = h('div');
      let parsed = A.splitQuery(A.urlRaw(req.url));
      const sync = () => { req.url = A.joinQuery(parsed.base, parsed.params, parsed.hash); urlIn.value = req.url; save(); drawVars(); };
      drawParams = () => {
        parsed = A.splitQuery(A.urlRaw(req.url));
        clear(pbox).appendChild(kvTable(parsed.params, { onChange: sync, keyPh: 'param' }));
        pbox.appendChild(h('p', { class: 'hint', text: 'Параметры синхронизированы со строкой URL. Значения отправляются как написаны — {{переменные}} подставляются при запуске.' }));
      };
      drawParams();
      box.appendChild(pbox);
    }
    if (cur === 'headers') box.appendChild(kvTable(req.header, { onChange: () => { save(); drawVars(); }, keyPh: 'Header' }));
    if (cur === 'body') box.appendChild(bodyEditor(req));
    if (cur === 'auth') box.appendChild(authEditor(it));
    if (cur === 'checks') box.appendChild(checksEditor(it));
    if (cur === 'scripts') box.appendChild(scriptsEditor(it));
  }

  function removeSelected() {
    const f = selected();
    if (!f) return;
    if (!confirm('Удалить «' + f.item.name + '»' + (f.item.item ? ' вместе со всеми запросами внутри' : '') + '?')) return;
    f.list.splice(f.list.indexOf(f.item), 1);
    S.selectedId = null;
    onCollectionChanged(); renderEditor(); renderResponse();
  }

  let sending = false;
  async function sendSelected() {
    const f = selected();
    if (!f || f.item.item || sending) return; // повторное нажатие во время отправки игнорируем
    sending = true;
    const btn = $('#sendBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Отправка…'; }
    const { envMap, collMap } = runtimeMaps();
    const scopes = A.makeScopes(S.coll, [], S.globals);
    scopes.env = envMap; scopes.collection = collMap;
    try {
      const r = await A.runItem(S.coll, f.item, f.parents, scopes, sendOpts({ contract: window.ATA_UI.contractForRun(), contractStrict: S.specStrict }));
      S.lastByItem[f.item._id] = r;
      syncBack(envMap, collMap);
      window.ATA_UI.addAdHocResult(r);
    } finally {
      sending = false;
      const b2 = $('#sendBtn'); // редактор мог перерисоваться за время запроса
      if (b2) { b2.disabled = false; b2.textContent = 'Отправить'; }
    }
    renderTree(); renderResponse();
    if (S.editorTab === 'checks') renderEditor();
  }

  /* ---------- ответ ---------- */
  function renderResult(box, r, opts) {
    opts = opts || {};
    const resp = r.response;
    const a = A.analyze(r, { slowMs: S.settings.slowMs });
    const passed = r.tests.filter((t) => t.pass).length;
    box.appendChild(h('div', { class: 'row' },
      h('h2', { text: opts.title || 'Ответ', style: 'margin:0' }),
      resp ? statusBadge(resp.code) : h('span', { class: 'badge fail', text: r.error ? r.error.kind : 'нет ответа' }),
      resp ? h('span', { class: 'hint', text: (resp.status || '') + ' · ' + resp.timeMs + ' мс · ' + fmtSize(resp.size) }) : null,
      resp && resp.mocked ? h('span', { class: 'badge warn', text: 'мок: ' + resp.mocked }) : null,
      r.tests.length ? h('span', { class: 'badge ' + (passed === r.tests.length ? 'ok' : 'fail'), text: 'проверки ' + passed + '/' + r.tests.length }) : null,
      h('span', { style: 'flex:1' }),
      window.ATA_AI ? h('button', { class: 'btn sm', text: '✦ Спросить ИИ', title: r.pass ? 'Предложить проверки для ответа' : 'Разобрать причину падения', onclick: () => window.ATA_AI.askAbout(r, r.pass ? 'tests' : 'explain') }) : null,
      r.request ? h('button', { class: 'btn sm', text: 'cURL', onclick: () => copy(A.toCurl(r.request), 'cURL') }) : null,
      resp ? h('button', { class: 'btn sm', text: 'В мок', title: 'Создать правило мока из этого ответа', onclick: () => { S.mocks.unshift(A.mockFromResult(r)); save(); window.ATA_UI.renderMocks(); renderMockToggle(); toast('Правило мока создано на вкладке «Моки»'); } }) : null,
      !r.pass ? h('button', { class: 'btn sm', text: 'Баг-репорт', onclick: () => copy(A.bugReport(r, a, env().name), 'Баг-репорт') }) : null));
    if (r.error) box.appendChild(h('div', { class: 'notice', text: r.error.message }));
    const tabs = [['body', 'Тело'], ['headers', 'Заголовки'], ['tests', 'Проверки (' + r.tests.length + ')'], ['request', 'Запрос'], ['console', 'Консоль (' + r.logs.length + ')'], ['analysis', 'Анализ' + (a.findings.length ? ' (' + a.findings.length + ')' : '')]];
    let cur = opts.tab || S.respTab;
    if (!tabs.some(([id]) => id === cur)) cur = 'body';
    const content = h('div');
    const draw = (t) => {
      cur = t; if (!opts.tab) S.respTab = t;
      clear(content);
      content.appendChild(subTabs(tabs, t, draw));
      if (t === 'body') content.appendChild(resp ? bodyView(r) : h('div', { class: 'empty', text: 'Ответа нет' }));
      if (t === 'headers') content.appendChild(resp ? h('table', {}, resp.headers.map(([k, v]) => h('tr', {}, h('td', { class: 'mono', text: k }), h('td', { class: 'mono', text: v })))) : h('div', { class: 'empty', text: 'Ответа нет' }));
      if (t === 'tests') content.appendChild(testsList(r));
      if (t === 'request') content.appendChild(r.request ? h('pre', { class: 'out' }, r.request.method + ' ' + r.request.url + '\n' + A.maskReq(r.request).headers.map(([k, v]) => k + ': ' + v).join('\n') + (typeof r.request.body === 'string' && r.request.body ? '\n\n' + r.request.body : '')) : h('div', { class: 'empty', text: '—' }));
      if (t === 'console') content.appendChild(r.logs.length ? h('pre', { class: 'out' }, r.logs.map((l) => '[' + l.level + '] ' + l.text).join('\n')) : h('div', { class: 'empty', text: 'console.log ничего не выводил' }));
      if (t === 'analysis') content.appendChild(findingsView(a));
    };
    draw(cur);
    box.appendChild(content);
  }
  /* ---------- JSON-дерево ответа: клик по значению → проверка ---------- */
  S.bodyView = 'tree';
  const accOf = (k) => (typeof k === 'number' ? '[' + k + ']' : /^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
  const jType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  function bodyView(r) {
    const resp = r.response;
    const wrap = h('div');
    if (resp.json === undefined) { wrap.appendChild(h('pre', { class: 'out' }, resp.text || '(пустое тело)')); return wrap; }
    const pane = h('div');
    const draw = () => {
      clear(pane);
      if (S.bodyView === 'tree') pane.appendChild(jsonTree(resp.json, (acc, v, anchor) => pickMenu(r, acc, v, anchor)));
      else pane.appendChild(h('pre', { class: 'out' }, JSON.stringify(resp.json, null, 2)));
    };
    const btn = (mode, label) => h('button', { class: 'btn sm' + (S.bodyView === mode ? ' primary' : ''), text: label, onclick: () => { S.bodyView = mode; wrap.replaceWith(bodyView(r)); } });
    wrap.appendChild(h('div', { class: 'row', style: 'margin-bottom:6px' }, btn('tree', 'Дерево'), btn('text', 'Текст'), S.bodyView === 'tree' ? h('span', { class: 'hint', text: 'Нажмите на значение или ＋, чтобы добавить проверку или сохранить в переменную' }) : null));
    wrap.appendChild(pane);
    draw();
    return wrap;
  }
  function jsonTree(value, onPick) {
    const MAX = 100;
    let budget = 3000; // ограничение на число узлов, чтобы большие ответы не тормозили страницу
    const node = (key, v, acc, depth) => {
      budget--;
      const keyEl = key === null ? null : h('span', { class: 'jk', text: (typeof key === 'number' ? key : JSON.stringify(key)) + ': ' });
      if (v && typeof v === 'object') {
        const isArr = Array.isArray(v);
        const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
        const det = h('details', { open: depth < 2 && entries.length <= 50 });
        det.appendChild(h('summary', {}, keyEl, h('span', { class: 'jt', text: isArr ? 'Array(' + v.length + ')' : '{' + entries.length + '}' }), ' ',
          h('button', { class: 'jpick', title: 'Проверки для этого узла', text: '＋', onclick: (e) => { e.preventDefault(); e.stopPropagation(); onPick(acc, v, e.currentTarget); } })));
        const box = h('div', { class: 'jchildren' });
        const fill = () => {
          if (box.childNodes.length) return;
          entries.slice(0, MAX).forEach(([k, x]) => { if (budget > 0) box.appendChild(node(k, x, acc + accOf(k), depth + 1)); });
          if (entries.length > MAX || budget <= 0) box.appendChild(h('div', { class: 'hint', text: '…показаны не все элементы (' + entries.length + ') — переключитесь на «Текст»' }));
        };
        if (det.open) fill(); else det.addEventListener('toggle', fill, { once: true });
        det.appendChild(box);
        return det;
      }
      const t = jType(v);
      const shown = typeof v === 'string' ? JSON.stringify(v.length > 200 ? v.slice(0, 200) + '…' : v) : String(v);
      return h('div', {}, keyEl, h('button', { class: 'jv jv-' + t, text: shown, title: 'Добавить проверку для $' + acc, onclick: (e) => onPick(acc, v, e.currentTarget) }));
    };
    return h('div', { class: 'jtree mono' }, node(null, value, '', 0));
  }
  function closeMenu() { const m = document.querySelector('.popmenu'); if (m) m.remove(); }
  document.addEventListener('click', (e) => { if (!e.target.closest('.popmenu, .jv, .jpick')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  function pickMenu(r, acc, v, anchor) {
    closeMenu();
    const item = A.findById(S.coll, r.id);
    const expr = 'pm.response.json()' + acc;
    const label = '$' + acc;
    const t = jType(v);
    const add = (title, body) => {
      if (!item) return toast('Запрос не найден в коллекции');
      const code = 'pm.test(' + JSON.stringify(title) + ', function () {\n    ' + body + '\n});';
      const cur = A.scriptOf(item.item, 'test');
      A.setScript(item.item, 'test', (cur ? cur.replace(/\s+$/, '') + '\n\n' : '') + code);
      save(); closeMenu();
      if (S.selectedId === r.id && S.editorTab === 'checks') renderEditor();
      toast('Проверка добавлена в Tests «' + item.item.name + '»');
    };
    const items = [];
    if (t !== 'object' && t !== 'array') {
      const shown = JSON.stringify(v);
      items.push(['= ' + (shown.length > 40 ? shown.slice(0, 37) + '…' : shown), () => add(label + ' = ' + (shown.length > 60 ? shown.slice(0, 57) + '…' : shown), 'pm.expect(' + expr + ').to.eql(' + shown + ');')]);
    }
    items.push([t === 'null' ? 'Значение null' : 'Тип: ' + t, () => add(label + ' — ' + t, t === 'null' ? 'pm.expect(' + expr + ').to.be.null;' : 'pm.expect(' + expr + ').to.be.' + (t === 'array' || t === 'object' ? 'an' : 'a') + '(' + JSON.stringify(t) + ');')]);
    if (acc) items.push(['Поле присутствует', () => add('Есть ' + label, 'pm.expect(' + expr + ').to.not.be.undefined;')]);
    if (t === 'array') {
      items.push(['Длина = ' + v.length, () => add(label + ': ' + v.length + ' элементов', 'pm.expect(' + expr + ').to.have.lengthOf(' + v.length + ');')]);
      items.push(['Не пустой', () => add(label + ' не пустой', 'pm.expect(' + expr + ').to.not.be.empty;')]);
    }
    if (t === 'string') items.push(['Не пустая строка', () => add(label + ' — непустая строка', 'pm.expect(' + expr + ').to.be.a("string").and.not.be.empty;')]);
    if (t !== 'object' && t !== 'array' && acc) items.push(['Сохранить в переменную…', () => {
      const def = (acc.match(/([A-Za-z_$][\w$]*)$/) || [])[1] || 'value';
      const name = prompt('Имя переменной окружения', def);
      if (!name || !item) return;
      const cur = A.scriptOf(item.item, 'test');
      A.setScript(item.item, 'test', (cur ? cur.replace(/\s+$/, '') + '\n\n' : '') + '// значение для следующих запросов: {{' + name + '}}\npm.environment.set(' + JSON.stringify(name) + ', ' + expr + ');');
      save(); closeMenu();
      toast('После запуска «' + item.item.name + '» значение будет в {{' + name + '}}');
    }]);
    items.push(['Копировать путь', () => { copy(expr, 'Путь'); closeMenu(); }]);
    const menu = h('div', { class: 'popmenu', role: 'menu' }, h('div', { class: 'ttl', text: label || '$ (корень)' }), items.map(([l, fn]) => h('button', { role: 'menuitem', text: l, onclick: fn })));
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    menu.style.left = Math.max(8, Math.min(window.scrollX + rect.left, window.scrollX + document.documentElement.clientWidth - mw - 8)) + 'px';
    menu.style.top = (window.scrollY + rect.bottom + 4) + 'px';
    const first = menu.querySelector('button'); if (first) first.focus();
  }

  function testsList(r) {
    const ul = h('ul', { class: 'tests' });
    if (!r.tests.length && !r.scriptErrors.length && !r.contract) ul.appendChild(h('li', { class: 'hint', text: 'Проверок нет — добавьте их на вкладке «Проверки» запроса или сгенерируйте кейсы.' }));
    r.tests.forEach((t) => ul.appendChild(h('li', {}, h('span', { class: 'badge ' + (t.skipped ? '' : t.pass ? 'ok' : t.unsupported ? 'warn' : 'fail'), text: t.skipped ? 'SKIP' : t.pass ? 'PASS' : 'FAIL' }), h('div', {}, h('div', { text: t.name }), t.message ? h('div', { class: 'msg', text: t.message }) : null))));
    r.scriptErrors.forEach((e) => ul.appendChild(h('li', {}, h('span', { class: 'badge ' + (e.unsupported ? 'warn' : 'fail'), text: 'SCRIPT' }), h('div', {}, h('div', { text: 'Ошибка ' + e.where }), h('div', { class: 'msg', text: e.name + ': ' + e.message })))));
    if (r.contract) {
      const issues = r.contract.issues;
      ul.appendChild(h('li', {}, h('span', { class: 'badge ' + (issues.filter((i) => i.kind !== 'extra-warn').length ? 'fail' : 'ok'), text: 'CONTRACT' }), h('div', {}, h('div', { text: 'Контракт' + (r.contract.op ? ': ' + r.contract.op.key : '') }), issues.map((i) => h('div', { class: 'msg', text: (i.path ? i.path + ': ' : '') + i.message })))));
    }
    return ul;
  }
  function findingsView(a) {
    const wrap = h('div');
    if (!a.findings.length) { wrap.appendChild(h('div', { class: 'empty', text: 'Замечаний нет ✓' })); return wrap; }
    a.findings.forEach((f) => wrap.appendChild(h('div', { class: 'finding ' + f.sev },
      h('div', { class: 'row' }, h('span', { class: 'badge ' + (f.sev === 'error' ? 'fail' : f.sev), text: f.category }), h('span', { class: 't', text: f.title })),
      f.why ? h('div', { class: 'why', text: f.why }) : null,
      f.steps.length ? h('ol', {}, f.steps.map((s) => h('li', { text: s }))) : null)));
    return wrap;
  }
  const fmtSize = (b) => (b > 1024 * 1024 ? (b / 1048576).toFixed(1) + ' МБ' : b > 1024 ? (b / 1024).toFixed(1) + ' КБ' : (b || 0) + ' Б');

  function renderResponse() {
    const box = clear($('#responsePanel'));
    const f = selected();
    const r = f && S.lastByItem[f.item._id];
    box.classList.toggle('hide', !f || !!f.item.item);
    if (!f || f.item.item) return;
    if (!r) { box.appendChild(h('div', { class: 'empty', text: 'Нажмите «Отправить» (или Enter в строке URL), чтобы увидеть ответ.' })); return; }
    renderResult(box, r);
  }

  /* ---------- переменные ---------- */
  function renderVars() {
    $$('#varTabs button').forEach((b) => b.classList.toggle('active', b.dataset.v === S.varTab));
    const box = clear($('#varEditor'));
    if (S.varTab === 'env') {
      const e = env();
      box.appendChild(h('div', { class: 'row' },
        h('input', { type: 'text', class: 'grow', value: e.name, 'aria-label': 'Название окружения', oninput: (ev) => { e.name = ev.target.value; renderEnvSelect(); save(); } }),
        h('button', { class: 'btn sm', text: '+ Новое', onclick: () => { S.envs.push({ name: 'Окружение ' + S.envs.length, values: [{ key: 'baseUrl', value: '', type: 'default', enabled: true }] }); S.envIdx = S.envs.length - 1; renderEnvSelect(); renderVars(); save(); } }),
        S.envs.length > 1 ? h('button', { class: 'btn sm danger', text: 'Удалить', onclick: () => { if (!confirm('Удалить окружение «' + e.name + '»?')) return; S.envs.splice(S.envIdx, 1); S.envIdx = 0; renderEnvSelect(); renderVars(); save(); } }) : null));
      box.appendChild(kvTable(e.values, { enabledKey: 'enabled', secret: true, onChange: save, keyPh: 'baseUrl' }));
      box.appendChild(h('p', { class: 'hint', text: '🔒 — секрет: не сохраняется в браузере после перезагрузки и не попадает в экспорт без явного выбора.' }));
    } else if (S.varTab === 'flow') {
      renderFlow(box);
    } else {
      box.appendChild(kvTable(S.coll.variable, { onChange: save }));
      box.appendChild(h('p', { class: 'hint', text: 'Переменные коллекции экспортируются вместе с коллекцией. Значения окружения имеют приоритет.' }));
    }
    updateFlowCount();
  }
  function flowNow() {
    const { envMap, collMap } = runtimeMaps();
    const data = new Set(S.dataRows && S.dataRows[0] ? Object.keys(S.dataRows[0]) : []);
    return A.analyzeVarFlow(S.coll, { env: envMap, coll: collMap, data });
  }
  function updateFlowCount() {
    const el = $('#flowCount');
    if (!el) return;
    const n = flowNow().issues.filter((i) => i.sev !== 'info').length;
    el.textContent = String(n); el.classList.toggle('hide', !n);
  }
  function renderFlow(box) {
    const flow = flowNow();
    if (!flow.vars.length) { box.appendChild(h('div', { class: 'empty', text: 'В коллекции нет {{переменных}}' })); return; }
    const SEV = { error: 'fail', warn: 'warn', info: 'info' };
    const SRC = { env: 'окружение', collection: 'коллекция', data: 'файл данных', script: 'скрипт' };
    const ref = (x) => h('button', { class: 'btn sm', style: 'margin:2px', title: x.where ? 'в ' + x.where : '', onclick: () => { if (x.id && x.id !== '__coll') select(x.id); } }, x.method ? methodBadge(x.method) : null, ' ', x.name);
    box.appendChild(h('p', { class: 'hint', text: 'Порядок — как при запуске коллекции. Видно, где переменная задаётся, где используется и что может пойти не так.' }));
    flow.vars.forEach((v) => box.appendChild(h('div', { class: 'finding ' + (v.issues[0] ? (v.issues[0].sev === 'error' ? 'error' : v.issues[0].sev) : '') },
      h('div', { class: 'row' }, h('strong', { class: 'mono', text: '{{' + v.name + '}}' }), h('span', { class: 'badge', text: v.source ? SRC[v.source] : 'не задана' })),
      v.issues.map((i) => h('div', {}, h('span', { class: 'badge ' + SEV[i.sev], text: i.sev === 'error' ? 'ошибка' : i.sev === 'warn' ? 'внимание' : 'инфо' }), ' ', i.text)),
      v.setBy.length ? h('div', { class: 'hint' }, 'Ставит: ', v.setBy.map(ref)) : null,
      v.usedBy.length <= 3 ? (v.usedBy.length ? h('div', { class: 'hint' }, 'Используют: ', v.usedBy.map(ref)) : null)
        : h('details', { class: 'hint' }, h('summary', { text: 'Используют ' + v.usedBy.length + ' запросов' }), v.usedBy.slice(0, 30).map(ref), v.usedBy.length > 30 ? ' …' : ''))));
  }
  $('#varTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) { S.varTab = b.dataset.v; renderVars(); } });

  /* ---------- импорт / экспорт ---------- */
  let yamlLoading;
  function loadYaml() {
    if (window.jsyaml) return Promise.resolve(window.jsyaml);
    if (!yamlLoading) yamlLoading = new Promise((resolve, reject) => {
      const s = h('script', { src: 'https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js' });
      s.onload = () => resolve(window.jsyaml); s.onerror = () => { yamlLoading = null; reject(new Error('Не удалось загрузить парсер YAML (нет интернета?) — сконвертируйте спеку в JSON')); };
      document.head.appendChild(s);
    });
    return yamlLoading;
  }
  async function parseAny(text) {
    const t = text.trim();
    if (/^curl\s/i.test(t)) return { kind: 'curl', item: A.fromCurl(t) };
    try { return { kind: 'json', data: JSON.parse(t) }; } catch (e) {
      if (/^(openapi|swagger)\s*:/m.test(t)) { const y = await loadYaml(); return { kind: 'json', data: y.load(t) }; }
      throw new Error('Не удалось разобрать: это не JSON, не YAML-спека и не cURL (' + e.message + ')');
    }
  }
  async function parseSpecText(text) {
    const p = await parseAny(text);
    if (p.kind !== 'json' || !A.isOpenApi(p.data)) throw new Error('Это не OpenAPI/Swagger-документ (нет полей openapi/swagger и paths)');
    S.spec = p.data;
    return p.data;
  }

  async function importText(text, fileName) {
    const p = await parseAny(text);
    if (p.kind === 'curl') { addNode(p.item); return 'Запрос из cURL добавлен'; }
    const d = p.data;
    if (d && d.info && Array.isArray(d.item)) {
      const hasContent = S.coll.item.length > 0;
      if (hasContent && !confirm('Заменить текущую коллекцию «' + S.coll.info.name + '» на «' + d.info.name + '»?\n(Отмена — добавить запросы из файла в текущую коллекцию отдельной папкой)')) {
        const c = A.normalizeCollection(d);
        S.coll.item.push({ _id: A.uid(), name: d.info.name, item: c.item, auth: c.auth, event: c.event });
        (c.variable || []).forEach((v) => { if (!S.coll.variable.some((x) => x.key === v.key)) S.coll.variable.push(v); });
      } else {
        S.coll = A.normalizeCollection(d);
        S.lastByItem = {};
      }
      S.selectedId = null; onCollectionChanged(); renderEditor(); renderResponse(); renderVars();
      return 'Коллекция «' + d.info.name + '» загружена';
    }
    if (d && Array.isArray(d.values) && (d._postman_variable_scope === 'environment' || d.name !== undefined)) {
      S.envs.push({ name: d.name || fileName || 'Окружение', values: d.values.map((v) => ({ key: v.key, value: v.value, type: v.type || 'default', enabled: v.enabled !== false })) });
      if (S.envs[0].name === 'Без окружения' && !S.envs[0].values.length) S.envs.shift();
      S.envIdx = S.envs.length - 1;
      renderEnvSelect(); renderVars(); save();
      return 'Окружение «' + (d.name || fileName) + '» загружено';
    }
    if (A.isOpenApi(d)) {
      S.spec = d; S.specText = JSON.stringify(d, null, 2); window.ATA_UI.renderSpec();
      if (confirm('Это OpenAPI-спецификация. Она загружена на вкладку «Контракт».\nСоздать из неё коллекцию запросов?')) {
        S.coll = A.normalizeCollection(A.collectionFromOpenApi(d)); S.selectedId = null; S.lastByItem = {};
        onCollectionChanged(); renderEditor(); renderResponse(); renderVars();
        return 'Коллекция создана из OpenAPI';
      }
      save();
      return 'Спецификация загружена на вкладку «Контракт»';
    }
    throw new Error('Не распознан формат: ожидается Postman collection v2.1, environment, OpenAPI или cURL');
  }

  const importDlg = $('#importDlg');
  function openImport() { $('#importText').value = ''; importDlg.showModal(); }
  $('#importBtn').addEventListener('click', openImport);
  $('#importCancel').addEventListener('click', () => importDlg.close());
  $('#importFile').addEventListener('click', () => $('#fileInput').click());
  $('#importPaste').addEventListener('click', async () => {
    const t = $('#importText').value;
    if (!t.trim()) return toast('Вставьте JSON или cURL');
    try { toast(await importText(t)); importDlg.close(); } catch (e) { toast(e.message); }
  });
  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    // коллекции раньше окружений, чтобы окружение не потерялось при замене
    files.sort((a, b) => /environment/i.test(a.name) - /environment/i.test(b.name));
    const msgs = [];
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { msgs.push(f.name + ': файл больше 20 МБ'); continue; }
      try { msgs.push(await importText(await f.text(), f.name.replace(/\.(postman_environment|postman_collection)?\.json$/i, ''))); } catch (err) { msgs.push(f.name + ': ' + err.message); }
    }
    if (importDlg.open) importDlg.close();
    toast(msgs.join(' · '));
  }
  $('#fileInput').addEventListener('change', async (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; await importFiles(files); });

  // перетаскивание файлов на страницу
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    // файлы данных для раннера (CSV) обрабатываются на вкладке «Запуск»
    const files = Array.from(e.dataTransfer.files);
    const csv = files.filter((f) => /\.csv$/i.test(f.name));
    if (csv.length && window.ATA_UI.loadDataFile) { window.ATA_UI.loadDataFile(csv[0]); setTab('runner'); }
    importFiles(files.filter((f) => !/\.csv$/i.test(f.name)));
  });

  // ⌘/Ctrl+Enter — отправить выбранный запрос
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && $('#tab-collection').classList.contains('active')) {
      const f = selected();
      if (f && !f.item.item) { e.preventDefault(); sendSelected(); }
    }
  });
  $('#importDemo').addEventListener('click', async () => {
    try {
      const [c, en, sp] = await Promise.all(['examples/sample.postman_collection.json', 'examples/sample.postman_environment.json', 'examples/jsonplaceholder.openapi.json'].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ': ' + r.status); return r.text(); })));
      S.coll = A.normalizeCollection(JSON.parse(c)); S.lastByItem = {}; S.selectedId = null;
      const envD = JSON.parse(en);
      S.envs = S.envs.filter((x) => x.name !== envD.name && !(x.name === 'Без окружения' && !x.values.length));
      S.envs.push({ name: envD.name, values: envD.values });
      S.envIdx = S.envs.length - 1;
      S.specText = sp; S.spec = JSON.parse(sp);
      renderEnvSelect(); onCollectionChanged(); renderEditor(); renderResponse(); renderVars(); window.ATA_UI.renderSpec();
      importDlg.close();
      toast('Демо загружено: коллекция, окружение и OpenAPI-контракт');
    } catch (e) {
      toast('Демо не загрузилось (' + e.message + '). Откройте страницу через локальный сервер или выберите файлы из папки examples/ вручную.');
    }
  });

  const exportDlg = $('#exportDlg');
  $('#exportBtn').addEventListener('click', () => exportDlg.showModal());
  $('#exportClose').addEventListener('click', () => exportDlg.close());
  $('#expColl').addEventListener('click', () => {
    const c = A.exportCollection(S.coll);
    if (!$('#expSecrets').checked) {
      const strip = (n) => { const a = n && (n.auth || (n.request && n.request.auth)); if (a && Array.isArray(a[a.type])) a[a.type].forEach((p) => { if (/token|password|value/.test(p.key) && !/^\{\{.*\}\}$/.test(String(p.value || ''))) p.value = ''; }); (n.item || []).forEach(strip); };
      strip(c);
      (c.variable || []).forEach((v) => { if (isSecretKey(v)) v.value = ''; });
    }
    download(fileSafe(S.coll.info.name) + '.postman_collection.json', c);
  });
  $('#expEnv').addEventListener('click', () => {
    const e = env();
    const withSecrets = $('#expSecrets').checked;
    download(fileSafe(e.name) + '.postman_environment.json', { id: A.uuid(), name: e.name, values: e.values.filter((v) => v.key).map((v) => ({ key: v.key, value: !withSecrets && isSecretKey(v) ? '' : v.value, type: isSecretKey(v) ? 'secret' : v.type || 'default', enabled: v.enabled !== false })), _postman_variable_scope: 'environment' });
  });

  /* ---------- настройки ---------- */
  const settingsDlg = $('#settingsDlg');
  $('#settingsBtn').addEventListener('click', () => {
    $('#setTimeout').value = S.settings.timeout; $('#setSlow').value = S.settings.slowMs; $('#setProxy').value = S.settings.proxy || '';
    settingsDlg.showModal();
  });
  $('#settingsClose').addEventListener('click', () => {
    S.settings.timeout = Math.max(100, Number($('#setTimeout').value) || 15000);
    S.settings.slowMs = Math.max(1, Number($('#setSlow').value) || 2000);
    S.settings.proxy = $('#setProxy').value.trim();
    save(); settingsDlg.close();
  });
  $('#settingsReset').addEventListener('click', () => {
    if (!confirm('Удалить коллекцию, окружения, моки и настройки, сохранённые этой страницей в браузере?')) return;
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    location.reload();
  });

  /* ---------- экспорт для второй части UI ---------- */
  window.ATA_APP = { S, h, $, $$, clear, toast, copy, download, fileSafe, methodBadge, statusBadge, save, env, runtimeMaps, syncBack, sendOpts, allTargets, renderTree, renderEditor, renderResponse, renderVars, renderResult, findingsView, testsList, renderMockToggle, onCollectionChanged, select, setTab, parseSpecText, fmtSize, isSecretKey, subTabs, kvTable };

  /* ---------- старт ---------- */
  try { const t = localStorage.getItem('ata-theme'); if (t) applyTheme(t); } catch (e) { /* ignore */ }
  load();
  window.addEventListener('DOMContentLoaded', () => {
    renderEnvSelect(); renderMockToggle(); renderTree(); renderEditor(); renderResponse(); renderVars();
    window.ATA_UI && window.ATA_UI.init();
    let tab = 'collection';
    try { tab = localStorage.getItem('ata-tab') || 'collection'; } catch (e) { /* ignore */ }
    setTab($('#tab-' + tab) ? tab : 'collection');
    if (!S.coll.item.length) openImport();
    if (location.protocol === 'file:') toast('Совет: запустите через локальный сервер (см. README), чтобы работали демо и запросы к API без проблем с CORS');
  });
})();
