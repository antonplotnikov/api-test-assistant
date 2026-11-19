/* UI, часть 3: сравнение окружений и сканер безопасности. */
(function () {
  'use strict';
  const A = window.ATA;
  const P = window.ATA_APP;
  const UI = window.ATA_UI;
  const { S, h, $, clear, toast } = P;
  const short = (v) => { let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } if (s === undefined) s = String(v); return s.length > 80 ? s.slice(0, 77) + '…' : s; };

  /* ---------- сравнение окружений ---------- */
  function fillCompare() {
    const scope = $('#cmpScope');
    const prev = scope.value;
    clear(scope);
    Array.from($('#runScope').options).forEach((o) => scope.appendChild(h('option', { value: o.value, text: o.text })));
    if (Array.from(scope.options).some((o) => o.value === prev)) scope.value = prev;
    ['#cmpEnvA', '#cmpEnvB'].forEach((sel, k) => {
      const el = $(sel);
      const pv = el.value;
      clear(el);
      S.envs.forEach((e, i) => el.appendChild(h('option', { value: i, text: e.name })));
      el.value = pv !== '' && S.envs[Number(pv)] ? pv : String(Math.min(k, S.envs.length - 1));
    });
  }

  const envMapOf = (i) => new Map(S.envs[i].values.filter((v) => v.enabled !== false && v.key).map((v) => [v.key, v.value == null ? '' : String(v.value)]));
  const collMap = () => new Map((S.coll.variable || []).filter((v) => v.key && !v.disabled).map((v) => [v.key, v.value == null ? '' : String(v.value)]));
  let cmpBusy = false;

  async function runCompare() {
    if (cmpBusy) return;
    const a = Number($('#cmpEnvA').value), b = Number($('#cmpEnvB').value);
    if (S.envs.length < 2) return toast('Нужно минимум два окружения: создайте второе на вкладке «Коллекция → Переменные»');
    if (a === b) return toast('Выберите два разных окружения');
    const onlyGet = $('#cmpOnlyGet').checked;
    let targets = P.allTargets($('#cmpScope').value || null);
    if (onlyGet) targets = targets.filter((t) => /^(GET|HEAD)$/.test(t.item.request.method));
    if (!targets.length) return toast(onlyGet ? 'В выбранной области нет GET-запросов' : 'В выбранной области нет запросов');
    if (!onlyGet && targets.some((t) => !/^(GET|HEAD)$/.test(t.item.request.method)) && !confirm('Запросы POST/PUT/PATCH/DELETE будут выполнены в обоих окружениях и могут изменить данные. Продолжить?')) return;
    const ignore = $('#cmpIgnore').value.split(',').map((s) => s.trim()).filter(Boolean);
    cmpBusy = true;
    $('#cmpBtn').disabled = true;
    let done = 0;
    const total = targets.length * 2;
    const status = $('#cmpStatus');
    const runIn = (i) => A.runCollection(S.coll, targets, P.sendOpts({ envMap: envMapOf(i), collectionMap: collMap(), onResult: () => { done++; status.textContent = 'Выполняется… ' + done + ' / ' + total; } }));
    try {
      const ra = await runIn(a);
      const rb = await runIn(b);
      renderCompare(targets, ra, rb, ignore, S.envs[a].name, S.envs[b].name);
      status.textContent = 'Готово: ' + targets.length + ' запросов в двух окружениях';
    } catch (e) {
      status.textContent = 'Ошибка: ' + e.message;
    } finally {
      cmpBusy = false;
      $('#cmpBtn').disabled = false;
    }
  }

  function compareOne(x, y, ignore) {
    if (!x || !y) return { verdict: 'error', diffs: [] };
    if (!x.response || !y.response) return { verdict: 'error', diffs: [] };
    let diffs = [];
    if (x.response.json !== undefined && y.response.json !== undefined) diffs = A.diffJson(x.response.json, y.response.json, { ignore });
    else if ((x.response.text || '') !== (y.response.text || '')) diffs = [{ path: '$', kind: 'changed', a: (x.response.text || '').slice(0, 80), b: (y.response.text || '').slice(0, 80) }];
    const statusDiff = x.response.code !== y.response.code;
    return { verdict: statusDiff ? 'status' : diffs.length ? 'body' : 'same', diffs, statusDiff };
  }

  function renderCompare(targets, ra, rb, ignore, nameA, nameB) {
    const box = clear($('#cmpResult'));
    const first = (list, id) => list.find((r) => r.id === id);
    const rows = targets.map((t) => { const x = first(ra, t.item._id), y = first(rb, t.item._id); return { t, x, y, c: compareOne(x, y, ignore) }; });
    const cnt = { same: 0, status: 0, body: 0, error: 0 };
    rows.forEach((r) => cnt[r.c.verdict]++);
    const st = h('div', { class: 'stats' });
    [['Совпадают', cnt.same, 'ok'], ['Разный статус', cnt.status, cnt.status ? 'fail' : ''], ['Разное тело', cnt.body, cnt.body ? 'warn' : ''], ['Ошибки', cnt.error, cnt.error ? 'fail' : '']].forEach(([l, v, c]) => st.appendChild(h('div', { class: 'stat' }, h('div', { class: 'v', style: c ? 'color:var(--' + c + ')' : '', text: String(v) }), h('div', { class: 'l', text: l }))));
    box.appendChild(st);
    const hasUnresolved = rows.some((r) => [r.x, r.y].some((q) => q && q.request && q.request.unresolved && q.request.unresolved.length));
    if (hasUnresolved) box.appendChild(h('div', { class: 'notice', text: 'В одном из окружений не заданы переменные (часто — токен: секреты не сохраняются после перезагрузки). Проверьте вкладку «Коллекция → Переменные».' }));
    const tbl = h('table');
    tbl.appendChild(h('tr', {}, ['Запрос', nameA, nameB, 'Итог'].map((x) => h('th', { text: x }))));
    const cell = (r) => h('td', {}, r && r.response ? [P.statusBadge(r.response.code), h('span', { class: 'hint', text: ' ' + r.response.timeMs + ' мс' })] : h('span', { class: 'badge fail', text: r && r.error ? r.error.kind : '—' }));
    const LABEL = { same: ['ok', 'совпадает'], status: ['fail', 'разный статус'], body: ['warn', 'отличий: '], error: ['fail', 'ошибка'] };
    rows.forEach((r) => {
      const [cls, label] = LABEL[r.c.verdict];
      const detail = h('tr', { class: 'hide' }, h('td', { colspan: 4 }, diffList(r, nameA, nameB)));
      tbl.appendChild(h('tr', { class: 'click', onclick: () => detail.classList.toggle('hide'), title: 'Показать отличия' },
        h('td', {}, P.methodBadge(r.t.item.request.method), ' ', r.t.item.name),
        cell(r.x), cell(r.y),
        h('td', {}, h('span', { class: 'badge ' + cls, text: label + (r.c.verdict === 'body' ? r.c.diffs.length : '') + (r.c.verdict === 'status' && r.c.diffs.length ? ' + тело' : '') }))));
      tbl.appendChild(detail);
    });
    box.appendChild(h('div', { class: 'tbl-wrap', style: 'margin-top:8px' }, tbl));
  }

  function diffList(r, nameA, nameB) {
    if (r.c.verdict === 'error') return h('div', { class: 'hint', text: [r.x, r.y].map((q, i) => (i ? nameB : nameA) + ': ' + (q && q.error ? q.error.message : q && q.response ? 'ответ ' + q.response.code : 'нет результата')).join(' · ') });
    if (!r.c.diffs.length) return h('div', { class: 'hint', text: r.c.statusDiff ? 'Тела совпадают, отличается только статус.' : 'Ответы совпадают (без учёта игнорируемых полей).' });
    const KIND = { changed: 'значение', type: 'тип', missing: 'нет в ' + nameB, added: 'нет в ' + nameA, length: 'длина массива' };
    const t = h('table');
    t.appendChild(h('tr', {}, ['Поле', 'Что', nameA, nameB].map((x) => h('th', { text: x }))));
    r.c.diffs.slice(0, 60).forEach((d) => t.appendChild(h('tr', {}, h('td', { class: 'mono', text: d.path }), h('td', { text: KIND[d.kind] || d.kind }), h('td', { class: 'mono', text: d.kind === 'added' ? '—' : short(d.a) }), h('td', { class: 'mono', text: d.kind === 'missing' ? '—' : short(d.b) }))));
    const wrap = h('div', { class: 'tbl-wrap' }, t);
    if (r.c.diffs.length > 60) wrap.appendChild(h('div', { class: 'hint', text: '…ещё ' + (r.c.diffs.length - 60) }));
    return wrap;
  }
  $('#cmpBtn').addEventListener('click', runCompare);

  /* ---------- безопасность ---------- */
  const SEV = { high: ['fail', 'Высокий'], medium: ['warn', 'Средний'], low: ['info', 'Низкий'], info: ['', 'Инфо'] };
  function renderSecurity() {
    const scan = A.scanAll(S.results, { load: S.lastLoad });
    const st = clear($('#secStats'));
    [['Проверено ответов', scan.scanned, ''], ['Высокий', scan.counts.high, scan.counts.high ? 'fail' : 'ok'], ['Средний', scan.counts.medium, scan.counts.medium ? 'warn' : ''], ['Низкий', scan.counts.low, ''], ['Инфо', scan.counts.info, '']].forEach(([l, v, c]) =>
      st.appendChild(h('div', { class: 'stat' }, h('div', { class: 'v', style: c ? 'color:var(--' + c + ')' : '', text: String(v) }), h('div', { class: 'l', text: l }))));
    const notice = clear($('#secNotice'));
    if (!S.results.length) notice.appendChild(h('div', { class: 'notice info', text: 'Нет результатов: запустите прогон или отправьте запросы — сканер проверит полученные ответы.' }));
    else if (scan.headersHidden) notice.appendChild(h('div', { class: 'notice info', text: 'Браузер скрывает заголовки ответов другого домена (CORS), поэтому проверки HSTS, nosniff, CSP, CORS и версии сервера пропущены. Чтобы их выполнить, используйте CORS-прокси из настроек с Access-Control-Expose-Headers или запустите коллекцию через Newman.' }));
    const el = $('#secCount');
    el.textContent = String(scan.counts.high); el.classList.toggle('hide', !scan.counts.high);
    $('#secInfo').textContent = S.lastLoad ? 'Учтён нагрузочный прогон «' + S.lastLoad.name + '»' : 'Совет: прогон на вкладке «Нагрузка» добавит проверку rate limit';
    const list = clear($('#secList'));
    if (S.results.length && !scan.findings.length) list.appendChild(h('div', { class: 'panel' }, h('div', { class: 'empty', text: 'Замечаний нет ✓ (в пределах того, что видно из браузера)' })));
    scan.findings.forEach((f) => {
      const [cls, label] = SEV[f.sev];
      list.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'row' }, h('span', { class: 'badge ' + cls, text: label }), h('strong', { text: f.title }), h('span', { style: 'flex:1' }),
          h('span', { class: 'badge', text: A.OWASP[f.owasp] || f.owasp, title: 'OWASP API Security Top 10 (2023)' }),
          window.ATA_AI ? h('button', { class: 'btn sm', text: '✦ Как исправить?', onclick: () => window.ATA_AI.askText('Сканер безопасности нашёл проблему: «' + f.title + '» (' + (A.OWASP[f.owasp] || f.owasp) + ').\n' + f.detail + '\nЗатронуты запросы: ' + f.affected.slice(0, 10).map((x) => (x.method ? x.method + ' ' : '') + x.name).join('; ') + '.\n\nОбъясни риск простыми словами, как подтвердить, что это реальная уязвимость, а не ложное срабатывание, как исправить на бэкенде и какие pm.test добавить, чтобы проблема не вернулась.') }) : null),
        h('div', { class: 'why', style: 'margin:6px 0', text: f.detail }),
        f.affected.length ? h('div', { class: 'row' }, h('span', { class: 'hint', text: 'Где:' }), f.affected.slice(0, 12).map((x) => h('button', { class: 'btn sm', title: 'Открыть в редакторе', onclick: () => { if (!x.id) return; P.setTab('collection'); P.select(x.id); } }, x.method ? P.methodBadge(x.method) : null, ' ', x.name, x.code != null ? ' · ' + x.code : '')), f.affected.length > 12 ? h('span', { class: 'hint', text: '…ещё ' + (f.affected.length - 12) }) : null) : null));
    });
  }
  $('#secScan').addEventListener('click', () => { renderSecurity(); toast('Просканировано ответов: ' + S.results.filter((r) => r.response).length); });
  $('#secGen').addEventListener('click', () => {
    P.setTab('generate');
    document.querySelectorAll('#genGroups input').forEach((c) => { c.checked = c.value === 'security'; });
    toast('Выберите запрос и нажмите «Сгенерировать». Кейсы безопасности запускайте только на тестовом стенде');
  });

  /* ---------- подключение к остальному UI ---------- */
  const baseRefresh = UI.refreshSelectors;
  UI.refreshSelectors = function () { baseRefresh(); fillCompare(); };
  UI.onTab_security = renderSecurity;
  UI.onTab_runner = fillCompare;
  UI.renderSecurity = renderSecurity;
  window.addEventListener('DOMContentLoaded', () => { fillCompare(); if (S.results.length) renderSecurity(); });
})();
