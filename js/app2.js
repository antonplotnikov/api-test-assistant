/* UI, часть 2: раннер, анализ падений, генерация, нагрузка, контракт, моки. */
(function () {
  'use strict';
  const A = window.ATA;
  const P = window.ATA_APP;
  const { S, h, $, clear, toast, copy, download, save } = P;

  let runAbort = null;
  let lastRun = []; // результаты последнего прогона (или одиночных запросов)

  /* ---------- общие селекторы запросов ---------- */
  function requestOptions(sel, keep) {
    const prev = keep ? sel.value : null;
    clear(sel);
    A.eachRequest(S.coll.item, (item, parents) => sel.appendChild(h('option', { value: item._id, text: (parents.length ? parents.map((p) => p.name).join(' / ') + ' / ' : '') + item.request.method + ' ' + item.name })));
    if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
    else if (S.selectedId && Array.from(sel.options).some((o) => o.value === S.selectedId)) sel.value = S.selectedId;
  }
  function refreshSelectors() {
    const scope = $('#runScope');
    const prev = scope.value;
    clear(scope).appendChild(h('option', { value: '', text: 'Вся коллекция «' + S.coll.info.name + '»' }));
    const walk = (items, depth) => items.forEach((it) => { if (it.item) { scope.appendChild(h('option', { value: it._id, text: '  '.repeat(depth) + '📁 ' + it.name })); walk(it.item, depth + 1); } });
    walk(S.coll.item, 1);
    if (Array.from(scope.options).some((o) => o.value === prev)) scope.value = prev;
    requestOptions($('#genSource'), true);
    requestOptions($('#loadSource'), true);
    requestOptions($('#failTarget'), true);
  }

  /* ---------- раннер ---------- */
  function contractForRun() { return $('#runContract').checked && S.spec ? S.spec : null; }

  async function run(folderId) {
    if (runAbort) return;
    const targets = P.allTargets(folderId || null);
    if (!targets.length) return toast('В выбранной области нет запросов');
    const iterations = S.dataRows ? S.dataRows.length : Math.max(1, Math.min(100, Number($('#runIter').value) || 1));
    const total = targets.length * iterations;
    const { envMap, collMap } = P.runtimeMaps();
    runAbort = new AbortController();
    lastRun = [];
    $('#runBtn').disabled = true; $('#stopBtn').classList.remove('hide');
    $('#runStatus').textContent = 'Выполняется…';
    renderRunTable();
    const t0 = performance.now();
    try {
      await A.runCollection(S.coll, targets, P.sendOpts({
        envMap, collectionMap: collMap, iterations, data: S.dataRows, delay: Number($('#runDelay').value) || 0, stopOnFail: $('#runStop').checked,
        contract: contractForRun(), contractStrict: S.specStrict, signal: runAbort.signal,
        onResult: (r) => {
          lastRun.push(r); S.lastByItem[r.id] = r;
          $('#runProgress').style.width = Math.min(100, (lastRun.length / total) * 100) + '%';
          $('#runStatus').textContent = lastRun.length + ' / ' + total;
          renderRunTable();
        },
      }));
    } finally {
      const aborted = runAbort.signal.aborted;
      runAbort = null;
      $('#runBtn').disabled = false; $('#stopBtn').classList.add('hide');
      $('#runStatus').textContent = (aborted ? 'Остановлено. ' : 'Готово. ') + lastRun.length + ' запросов за ' + ((performance.now() - t0) / 1000).toFixed(1) + ' с';
      P.syncBack(envMap, collMap);
      S.results = lastRun.slice();
      P.renderTree(); P.renderResponse();
      renderRunTable(); renderAnalysis(); updateFailCount();
      if ($('#tab-contract').classList.contains('active')) renderContractResults();
    }
  }
  $('#runBtn').addEventListener('click', () => run($('#runScope').value || null));
  $('#stopBtn').addEventListener('click', () => runAbort && runAbort.abort());

  function runFolder(id) { P.setTab('runner'); $('#runScope').value = id; run(id); }

  function addAdHocResult(r) {
    // одиночная отправка из редактора тоже попадает в анализ и контракт
    S.results = S.results.filter((x) => !(x.id === r.id && x.iteration === r.iteration)).concat([r]);
    lastRun = S.results;
    renderRunTable(); renderAnalysis(); updateFailCount();
  }

  function renderRunTable() {
    const tbl = clear($('#runTable'));
    const list = lastRun.length ? lastRun : S.results;
    const stats = $('#runStats');
    clear(stats);
    if (!list.length) { tbl.appendChild(h('tr', {}, h('td', { class: 'empty', text: 'Прогонов ещё не было. Выберите область и нажмите «Запустить».' }))); return; }
    const passed = list.filter((r) => r.pass).length;
    const times = list.filter((r) => r.response).map((r) => r.response.timeMs);
    const st = A.stats(times);
    const testsTotal = list.reduce((n, r) => n + r.tests.length, 0), testsPassed = list.reduce((n, r) => n + r.tests.filter((t) => t.pass).length, 0);
    [['Запросов', list.length], ['Успешно', passed, 'ok'], ['Упало', list.length - passed, list.length - passed ? 'fail' : ''], ['Проверок', testsPassed + '/' + testsTotal], ['Среднее время', Math.round(st.avg) + ' мс'], ['p95', st.p95 + ' мс']].forEach(([l, v, c]) =>
      stats.appendChild(h('div', { class: 'stat' }, h('div', { class: 'v', style: c ? 'color:var(--' + c + ')' : '', text: String(v) }), h('div', { class: 'l', text: l }))));
    const only = $('#onlyFailed').checked;
    const multiIter = list.some((r) => r.iteration > 0);
    tbl.appendChild(h('tr', {}, ['#', multiIter ? 'Итер.' : null, 'Запрос', 'Статус', 'Время', 'Проверки', 'Итог'].filter(Boolean).map((x) => h('th', { text: x }))));
    list.forEach((r, i) => {
      if (only && r.pass) return;
      const tp = r.tests.filter((t) => t.pass).length;
      tbl.appendChild(h('tr', { class: 'click', onclick: () => showDetail(r), title: 'Подробности' },
        h('td', { class: 'num', text: String(i + 1) }), multiIter ? h('td', { class: 'num', text: String(r.iteration + 1) }) : null,
        h('td', {}, r.request ? P.methodBadge(r.request.method) : null, ' ', r.name, r.folder ? h('div', { class: 'hint', text: r.folder }) : null),
        h('td', {}, r.response ? P.statusBadge(r.response.code) : h('span', { class: 'badge fail', text: r.error ? r.error.kind : r.skipped ? 'skip' : '—' }), r.response && r.response.mocked ? h('span', { class: 'badge warn', text: 'мок', style: 'margin-left:4px' }) : null),
        h('td', { class: 'num', text: r.response ? r.response.timeMs + ' мс' : '—' }),
        h('td', { class: 'num', text: r.tests.length ? tp + '/' + r.tests.length : '—' }),
        h('td', {}, h('span', { class: 'badge ' + (r.pass ? 'ok' : 'fail'), text: r.pass ? 'PASS' : 'FAIL' }))));
    });
  }
  $('#onlyFailed').addEventListener('change', renderRunTable);

  function showDetail(r) {
    const box = clear($('#runDetail'));
    box.classList.remove('hide');
    P.renderResult(box, r, { title: r.name, tab: r.pass ? 'tests' : 'analysis' });
    box.appendChild(h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn sm', text: 'Открыть в редакторе', onclick: () => { P.setTab('collection'); P.select(r.id); } }), h('button', { class: 'btn sm', text: 'Закрыть', onclick: () => box.classList.add('hide') })));
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#reportBtn').addEventListener('click', () => { if (!S.results.length) return toast('Сначала запустите прогон'); copy(A.runReport(S.results, P.env().name), 'Отчёт'); });
  $('#cliBtn').addEventListener('click', () => {
    const c = P.fileSafe(S.coll.info.name) + '.postman_collection.json', e = P.fileSafe(P.env().name) + '.postman_environment.json';
    const cmd = '# Экспортируйте коллекцию и окружение (кнопка «Экспорт»), затем:\n' +
      '# Newman\nnpx newman run ' + c + ' -e ' + e + (S.dataRows ? ' -d data.csv' : '') + ' --reporters cli,junit\n\n' +
      '# Postman CLI\npostman collection run ' + c + ' -e ' + e + (S.dataRows ? ' -d data.csv' : '');
    copy(cmd, 'Команда');
    alert(cmd);
  });

  // файл данных
  $('#dataBtn').addEventListener('click', () => (S.dataRows ? (S.dataRows = null, $('#dataInfo').textContent = '', $('#dataBtn').textContent = 'Файл данных (CSV/JSON)…', $('#runIter').disabled = false) : $('#dataInput').click()));
  $('#dataInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const rows = A.parseDataFile(await f.text());
      if (!rows.length) throw new Error('в файле нет строк данных');
      S.dataRows = rows;
      $('#dataInfo').textContent = f.name + ': ' + rows.length + ' итераций, поля: ' + Object.keys(rows[0]).join(', ');
      $('#dataBtn').textContent = 'Убрать файл данных';
      $('#runIter').disabled = true;
    } catch (err) { toast('Файл данных: ' + err.message); }
  });

  /* ---------- анализ ---------- */
  function updateFailCount() {
    const n = S.results.filter((r) => !r.pass).length;
    const el = $('#failCount');
    el.textContent = String(n); el.classList.toggle('hide', !n);
  }
  function renderAnalysis() {
    const sum = clear($('#analysisSummary'));
    const list = clear($('#analysisList'));
    const failed = S.results.filter((r) => !r.pass);
    if (!S.results.length) { sum.appendChild(h('div', { class: 'empty', text: 'Нет результатов: запустите прогон или отправьте запрос.' })); return; }
    if (!failed.length) { sum.appendChild(h('div', { class: 'notice info', text: 'Все ' + S.results.length + ' запросов прошли ✓' })); return; }
    const analyses = failed.map((r) => ({ r, a: A.analyze(r, { slowMs: S.settings.slowMs }) }));
    const groups = {};
    analyses.forEach(({ a }) => { groups[a.category] = (groups[a.category] || 0) + 1; });
    sum.appendChild(h('div', { class: 'row' }, h('strong', { text: 'Упало ' + failed.length + ' из ' + S.results.length + ':' }), Object.entries(groups).sort((x, y) => y[1] - x[1]).map(([k, v]) => h('span', { class: 'badge fail', text: v + ' × ' + k }))));
    const common = Object.entries(groups).sort((x, y) => y[1] - x[1])[0];
    if (common && common[1] >= Math.max(2, failed.length * 0.6) && /Авторизация|Сеть|Переменные|Таймаут/.test(common[0])) {
      sum.appendChild(h('div', { class: 'notice', text: 'Большинство падений одной природы («' + common[0] + '») — вероятно, общая причина (окружение, токен, доступность стенда), а не отдельные баги. Начните с неё.' }));
    }
    analyses.forEach(({ r, a }) => {
      list.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'row' }, r.request ? P.methodBadge(r.request.method) : null, h('strong', { text: r.name }), r.response ? P.statusBadge(r.response.code) : h('span', { class: 'badge fail', text: r.error ? r.error.kind : '' }), r.folder ? h('span', { class: 'hint', text: r.folder }) : null, h('span', { style: 'flex:1' }),
          h('button', { class: 'btn sm', text: 'Баг-репорт', onclick: () => copy(A.bugReport(r, a, P.env().name), 'Баг-репорт (Markdown)') }),
          r.request ? h('button', { class: 'btn sm', text: 'cURL', onclick: () => copy(A.toCurl(r.request), 'cURL') }) : null,
          h('button', { class: 'btn sm', text: 'Открыть', onclick: () => { P.setTab('collection'); P.select(r.id); } })),
        P.findingsView(a)));
    });
  }

  /* ---------- генерация ---------- */
  let genCases = [];
  function initGen() {
    const g = clear($('#genGroups'));
    Object.entries(A.CASE_GROUPS).forEach(([k, label]) => g.appendChild(h('label', { class: 'chk' }, h('input', { type: 'checkbox', value: k, checked: true }), label)));
  }
  $('#genBtn').addEventListener('click', () => {
    const f = A.findById(S.coll, $('#genSource').value);
    if (!f) return toast('Выберите запрос');
    const groups = new Set(Array.from(document.querySelectorAll('#genGroups input:checked')).map((x) => x.value));
    genCases = A.generateCases(f.item, { groups, okStatus: Number($('#genOk').value) || undefined, errorStatuses: $('#genErr').value || '400,422' });
    $('#genInfo').textContent = 'Кейсов: ' + genCases.length + (A.jsonBodyOf(f.item) === undefined && /POST|PUT|PATCH/.test(f.item.request.method) ? ' · у запроса нет JSON-тела — кейсы по полям не построены' : '');
    renderGenPreview(f);
  });
  function renderGenPreview(f) {
    const box = clear($('#genPreview'));
    box.classList.toggle('hide', !genCases.length);
    if (!genCases.length) return;
    box.appendChild(h('div', { class: 'row' }, h('h2', { text: 'Предпросмотр', style: 'margin:0' }), h('span', { style: 'flex:1' }),
      h('button', { class: 'btn sm', text: 'Выбрать все', onclick: () => box.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = true; }) }),
      h('button', { class: 'btn sm', text: 'Снять все', onclick: () => box.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; }) })));
    const listEl = h('div', { class: 'case-list', style: 'margin-top:8px' });
    genCases.forEach((c, i) => {
      const tests = Array.from(A.scriptOf(c, 'test').matchAll(/pm\.test\(\s*"((?:\\.|[^"])*)"/g)).map((m) => m[1]);
      listEl.appendChild(h('label', {}, h('input', { type: 'checkbox', checked: true, 'data-i': i }),
        h('div', {}, h('div', {}, P.methodBadge(c.request.method), ' ', c.name.replace(f.item.name + ' — ', ''), ' ', h('span', { class: 'badge', text: A.CASE_GROUPS[c._group] })), h('div', { class: 'hint', text: 'Проверки: ' + tests.join('; ') }))));
    });
    box.appendChild(listEl);
    box.appendChild(h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn primary', text: 'Добавить в коллекцию', onclick: () => addCases(f, false) }),
      h('button', { class: 'btn', text: 'Добавить и запустить', onclick: () => addCases(f, true) })));
  }
  function addCases(f, runNow) {
    const chosen = Array.from(document.querySelectorAll('#genPreview input[data-i]:checked')).map((x) => genCases[Number(x.dataset.i)]);
    if (!chosen.length) return toast('Не выбрано ни одного кейса');
    chosen.forEach((c) => delete c._group);
    const folder = { _id: A.uid(), name: 'Кейсы: ' + f.item.name, item: chosen };
    // папку кладём рядом с исходным запросом: так наследуются auth и скрипты родителей
    f.list.splice(f.list.indexOf(f.item) + 1, 0, folder);
    genCases = []; renderGenPreview(f);
    P.onCollectionChanged();
    toast('Добавлено кейсов: ' + chosen.length + ' (папка «' + folder.name + '»)');
    if (runNow) runFolder(folder._id);
  }

  /* ---------- нагрузка ---------- */
  let loadAbort = null;
  $('#loadBtn').addEventListener('click', async () => {
    const f = A.findById(S.coll, $('#loadSource').value);
    if (!f) return toast('Выберите запрос');
    const total = Math.max(1, Math.min(2000, Number($('#loadTotal').value) || 100));
    const conc = Math.max(1, Math.min(50, Number($('#loadConc').value) || 5));
    if (!S.mockMode && total > 200 && !confirm('Отправить ' + total + ' запросов на ' + (A.buildRequest(S.coll, f.item, f.parents, A.scopeList(scopesNow())).url) + '?\nУбедитесь, что это ваш тестовый стенд.')) return;
    if (/^(POST|PUT|PATCH|DELETE)$/.test(f.item.request.method) && !S.mockMode && !confirm('Запрос ' + f.item.request.method + ' изменяет данные. Отправить его ' + total + ' раз?')) return;
    loadAbort = new AbortController();
    $('#loadBtn').disabled = true; $('#loadStop').classList.remove('hide');
    $('#loadStatus').textContent = 'Выполняется…';
    let lastDraw = 0;
    const res = await A.loadTest(() => A.buildRequest(S.coll, f.item, f.parents, A.scopeList(scopesNow())), P.sendOpts({
      total, concurrency: conc, signal: loadAbort.signal,
      onProgress: (samples, codes) => {
        $('#loadProgress').style.width = (samples.length / total) * 100 + '%';
        const now = performance.now();
        if (now - lastDraw > 150 || samples.length === total) { lastDraw = now; drawLoad({ samples, statusCounts: codes, latency: A.stats(samples.filter((x) => typeof x.code === 'number').map((x) => x.ms)) }, true); }
      },
    }));
    loadAbort = null;
    $('#loadBtn').disabled = false; $('#loadStop').classList.add('hide');
    $('#loadStatus').textContent = 'Готово: ' + res.samples.length + ' запросов за ' + res.elapsed.toFixed(1) + ' с' + (S.mockMode ? ' (моки включены!)' : '');
    drawLoad(res, false);
  });
  $('#loadStop').addEventListener('click', () => loadAbort && loadAbort.abort());
  function scopesNow() {
    const { envMap, collMap } = P.runtimeMaps();
    const sc = A.makeScopes(S.coll, [], S.globals);
    sc.env = envMap; sc.collection = collMap;
    return sc;
  }

  function drawLoad(res, partial) {
    const st = clear($('#loadStats'));
    const L = res.latency;
    const errRate = res.samples.length ? res.samples.filter((x) => !x.ok).length / res.samples.length : 0;
    [['Запросов', res.samples.length], ['RPS', partial ? '…' : res.rps.toFixed(1)], ['Ошибок', (errRate * 100).toFixed(1) + '%', errRate > 0 ? 'fail' : 'ok'], ['p50', L.p50 + ' мс'], ['p90', L.p90 + ' мс'], ['p95', L.p95 + ' мс'], ['p99', L.p99 + ' мс'], ['min / max', L.min + ' / ' + L.max]].forEach(([l, v, c]) =>
      st.appendChild(h('div', { class: 'stat' }, h('div', { class: 'v', style: c ? 'color:var(--' + c + ')' : '', text: String(v) }), h('div', { class: 'l', text: l }))));
    const codes = clear($('#loadCodes'));
    Object.entries(res.statusCounts).forEach(([k, v]) => codes.appendChild(h('span', {}, P.statusBadge(isNaN(Number(k)) ? k : Number(k)), ' × ' + v)));
    scatter($('#loadScatter'), res.samples, L.p95);
    histogram($('#loadHist'), res.samples.filter((x) => typeof x.code === 'number').map((x) => x.ms));
  }

  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const el = document.createElementNS(NS, tag); Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v)); return el; };
  function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); return Math.ceil(v / p) * p; }
  function axes(svg, W, H, pad, maxY, xLabel) {
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (H - pad.t - pad.b) * (1 - i / 4);
      svg.appendChild(sv('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'axis' }));
      const t = sv('text', { x: pad.l - 6, y: y + 4, 'text-anchor': 'end' }); t.textContent = Math.round((maxY * i) / 4); svg.appendChild(t);
    }
    const t = sv('text', { x: W - pad.r, y: H - 4, 'text-anchor': 'end' }); t.textContent = xLabel; svg.appendChild(t);
  }
  function scatter(svg, samples, p95) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = svg.clientWidth || 500, H = 220, pad = { l: 48, r: 10, t: 10, b: 22 };
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!samples.length) return;
    const maxY = niceMax(Math.max(...samples.map((s) => s.ms)));
    const maxX = Math.max(...samples.map((s) => s.n)) + 1;
    axes(svg, W, H, pad, maxY, '№ запроса → (мс по оси Y)');
    const x = (n) => pad.l + ((W - pad.l - pad.r) * n) / Math.max(1, maxX - 1);
    const y = (ms) => pad.t + (H - pad.t - pad.b) * (1 - ms / maxY);
    const r = samples.length > 500 ? 1.5 : 2.5;
    samples.forEach((s) => { const c = sv('circle', { cx: x(s.n), cy: y(s.ms), r, class: s.ok ? 'pt-ok' : 'pt-fail' }); const tt = sv('title'); tt.textContent = '#' + (s.n + 1) + ': ' + s.ms + ' мс, ' + s.code; c.appendChild(tt); svg.appendChild(c); });
    if (p95) { svg.appendChild(sv('line', { x1: pad.l, x2: W - pad.r, y1: y(p95), y2: y(p95), class: 'p95' })); const t = sv('text', { x: W - pad.r - 4, y: y(p95) - 4, 'text-anchor': 'end' }); t.textContent = 'p95 ' + p95 + ' мс'; svg.appendChild(t); }
  }
  function histogram(svg, values) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = svg.clientWidth || 500, H = 220, pad = { l: 48, r: 10, t: 10, b: 22 };
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!values.length) return;
    const min = Math.min(...values), max = Math.max(...values);
    const bins = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(values.length))));
    const w = Math.max(1, (max - min) / bins);
    const counts = new Array(bins).fill(0);
    values.forEach((v) => { counts[Math.min(bins - 1, Math.floor((v - min) / w))]++; });
    const maxY = niceMax(Math.max(...counts));
    axes(svg, W, H, pad, maxY, 'мс: ' + min + ' … ' + max + ' (Y — кол-во)');
    const bw = (W - pad.l - pad.r) / bins;
    counts.forEach((c, i) => {
      const bh = ((H - pad.t - pad.b) * c) / maxY;
      const rect = sv('rect', { x: pad.l + i * bw + 1, y: H - pad.b - bh, width: Math.max(1, bw - 2), height: bh, class: 'bar', rx: 2 });
      const tt = sv('title'); tt.textContent = Math.round(min + i * w) + '–' + Math.round(min + (i + 1) * w) + ' мс: ' + c; rect.appendChild(tt);
      svg.appendChild(rect);
    });
  }

  /* ---------- контракт ---------- */
  function renderSpec() {
    $('#specText').value = S.specText || '';
    $('#specStrict').checked = S.specStrict;
    const info = $('#specInfo');
    if (!S.spec) { info.textContent = 'Спецификация не загружена.'; return; }
    const ops = A.listOperations(S.spec);
    info.textContent = '✓ ' + ((S.spec.info && S.spec.info.title) || 'спецификация') + ' ' + ((S.spec.info && S.spec.info.version) || '') + ' — операций: ' + ops.length;
    $('#runContract').checked = true;
  }
  $('#specFileBtn').addEventListener('click', () => $('#specInput').click());
  $('#specInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const text = await f.text();
    try { await P.parseSpecText(text); S.specText = text; save(); renderSpec(); renderContractResults(); toast('Спецификация загружена'); } catch (err) { toast(err.message); }
  });
  $('#specApply').addEventListener('click', async () => {
    const text = $('#specText').value;
    try { await P.parseSpecText(text); S.specText = text; save(); renderSpec(); renderContractResults(); toast('Спецификация применена'); } catch (err) { toast(err.message); }
  });
  $('#specStrict').addEventListener('change', (e) => { S.specStrict = e.target.checked; save(); renderContractResults(); });
  $('#contractCheck').addEventListener('click', renderContractResults);
  $('#specToColl').addEventListener('click', () => {
    if (!S.spec) return toast('Сначала загрузите спецификацию');
    const c = A.normalizeCollection(A.collectionFromOpenApi(S.spec));
    if (S.coll.item.length && !confirm('Заменить текущую коллекцию сгенерированной из OpenAPI?\n(Отмена — добавить отдельной папкой)')) {
      S.coll.item.push({ _id: A.uid(), name: c.info.name, item: c.item });
      c.variable.forEach((v) => { if (!S.coll.variable.some((x) => x.key === v.key)) S.coll.variable.push(v); });
    } else { S.coll = c; S.lastByItem = {}; S.selectedId = null; }
    P.onCollectionChanged(); P.renderEditor(); P.renderVars();
    toast('Коллекция из OpenAPI готова — проверьте baseUrl в переменных коллекции');
  });
  $('#specToMocks').addEventListener('click', () => {
    if (!S.spec) return toast('Сначала загрузите спецификацию');
    const ms = A.mocksFromOpenApi(S.spec);
    S.mocks = ms.concat(S.mocks); save(); renderMocks(); P.renderMockToggle();
    toast('Создано правил мока: ' + ms.length);
  });

  function renderContractResults() {
    const box = clear($('#contractResult'));
    if (!S.spec) { box.appendChild(h('div', { class: 'empty', text: 'Загрузите спецификацию.' })); return; }
    const withResp = S.results.filter((r) => r.response && r.request);
    const ops = A.listOperations(S.spec);
    const covered = new Set();
    let bad = 0;
    const rows = withResp.map((r) => {
      const c = A.checkContract(S.spec, r.request.method, r.request.url, r.response.code, r.response.json, S.specStrict);
      if (c.op) covered.add(c.op.key);
      const errs = c.issues.filter((i) => i.kind !== 'extra-warn');
      if (errs.length) bad++;
      return { r, c, errs };
    });
    box.appendChild(h('h2', { text: 'Результат проверки' }));
    const st = h('div', { class: 'stats' });
    [['Ответов проверено', withResp.length], ['С нарушениями', bad, bad ? 'fail' : 'ok'], ['Покрытие операций', covered.size + ' / ' + ops.length]].forEach(([l, v, c]) => st.appendChild(h('div', { class: 'stat' }, h('div', { class: 'v', style: c ? 'color:var(--' + c + ')' : '', text: String(v) }), h('div', { class: 'l', text: l }))));
    box.appendChild(st);
    if (!withResp.length) box.appendChild(h('div', { class: 'empty', text: 'Нет ответов для проверки — запустите прогон.' }));
    else {
      const tbl = h('table');
      tbl.appendChild(h('tr', {}, ['Запрос', 'Операция', 'Статус', 'Замечания'].map((x) => h('th', { text: x }))));
      rows.forEach(({ r, c, errs }) => tbl.appendChild(h('tr', {},
        h('td', {}, P.methodBadge(r.request.method), ' ', r.name),
        h('td', { class: 'mono', text: c.op ? c.op.key : '—' }),
        h('td', {}, P.statusBadge(r.response.code)),
        h('td', {}, c.issues.length ? c.issues.slice(0, 8).map((i) => h('div', {}, h('span', { class: 'badge ' + (i.kind === 'extra-warn' ? 'info' : i.kind === 'undocumented' ? 'warn' : 'fail'), text: { missing: 'нет поля', type: 'тип', extra: 'лишнее', 'extra-warn': 'не описано', format: 'формат', enum: 'значение', status: 'код', undocumented: 'нет в спеке', error: 'схема' }[i.kind] || i.kind }), ' ', h('span', { class: 'mono', text: i.path }), ' ', i.message)).concat(c.issues.length > 8 ? [h('div', { class: 'hint', text: '…ещё ' + (c.issues.length - 8) })] : []) : h('span', { class: 'badge ok', text: 'соответствует' })))));
      box.appendChild(h('div', { class: 'tbl-wrap' }, tbl));
    }
    const missing = ops.filter((o) => !covered.has(o.key));
    if (missing.length) {
      box.appendChild(h('h3', { text: 'Не покрыто тестами (' + missing.length + ')' }));
      box.appendChild(h('div', {}, missing.map((o) => h('div', { class: 'mono' }, P.methodBadge(o.method), ' ', o.path, o.op.summary ? h('span', { class: 'hint', text: ' — ' + o.op.summary }) : null))));
    }
  }

  /* ---------- моки ---------- */
  function renderMocks() {
    const box = clear($('#mockList'));
    $('#mockFallthrough').value = S.settings.fallthrough || 'network';
    if (!S.mocks.length) { box.appendChild(h('div', { class: 'panel' }, h('div', { class: 'empty', text: 'Правил нет. Добавьте правило, создайте моки из OpenAPI или из ответа («В мок» в панели ответа).' }))); return; }
    S.mocks.forEach((m, i) => {
      const upd = (k) => (e) => { m[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; save(); P.renderMockToggle(); };
      const method = h('select', { onchange: upd('method') }, ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((x) => h('option', { value: x, text: x })));
      method.value = m.method || 'ANY';
      const net = h('select', { onchange: upd('network') }, [['', 'Отвечать'], ['error', 'Сетевая ошибка']].map(([v, l]) => h('option', { value: v, text: l })));
      net.value = m.network || '';
      box.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'row' },
          h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: m.enabled, onchange: upd('enabled') }), 'вкл'),
          h('input', { type: 'text', class: 'grow', value: m.name || '', placeholder: 'Название правила', oninput: upd('name') }),
          h('button', { class: 'btn sm', text: '↑', title: 'Выше (правила проверяются сверху вниз)', disabled: i === 0, onclick: () => { S.mocks.splice(i - 1, 0, S.mocks.splice(i, 1)[0]); save(); renderMocks(); } }),
          h('button', { class: 'btn sm', text: 'Копия', onclick: () => { S.mocks.splice(i + 1, 0, Object.assign({}, m, { id: A.uid(), name: (m.name || '') + ' (копия)' })); save(); renderMocks(); } }),
          h('button', { class: 'btn sm danger', text: 'Удалить', onclick: () => { S.mocks.splice(i, 1); save(); renderMocks(); P.renderMockToggle(); } })),
        h('div', { class: 'row', style: 'margin-top:8px' }, method,
          h('input', { type: 'text', class: 'grow mono', value: m.path, placeholder: '/users/:id', oninput: upd('path') }),
          net,
          h('label', { class: 'f' }, 'Статус', h('input', { type: 'number', value: m.status, style: 'width:80px', oninput: upd('status') })),
          h('label', { class: 'f' }, 'Задержка, мс', h('input', { type: 'number', value: m.delay || 0, style: 'width:100px', oninput: upd('delay') }))),
        h('div', { class: 'cols', style: 'margin-top:8px' },
          h('label', { class: 'f' }, 'Заголовки (JSON)', h('textarea', { class: 'code', style: 'min-height:80px', spellcheck: 'false', value: m.headers || '{}', oninput: upd('headers') })),
          h('label', { class: 'f' }, 'Тело ответа', h('textarea', { class: 'code', style: 'min-height:80px', spellcheck: 'false', value: m.body || '', oninput: upd('body') })))));
    });
  }
  $('#mockAdd').addEventListener('click', () => { S.mocks.unshift(A.newMock({ name: 'Новое правило' })); save(); renderMocks(); P.renderMockToggle(); });
  $('#mockFallthrough').addEventListener('change', (e) => { S.settings.fallthrough = e.target.value; save(); });
  $('#mockExport').addEventListener('click', () => {
    if (!S.mocks.length) return toast('Нет правил для экспорта');
    download(P.fileSafe(S.coll.info.name + ' mocks') + '.postman_collection.json', A.exportCollection(A.collectionWithExamples(S.mocks, S.coll.info.name + ' — моки')));
    toast('Импортируйте файл в Postman и создайте из него Mock Server: сохранённые примеры станут ответами');
  });
  function initFailPresets() {
    const box = clear($('#failPresets'));
    Object.entries(A.FAILURE_PRESETS).forEach(([k, p]) => box.appendChild(h('button', { class: 'btn sm', text: p.label, onclick: () => {
      const f = A.findById(S.coll, $('#failTarget').value);
      if (!f) return toast('Выберите запрос');
      const req = A.buildRequest(S.coll, f.item, f.parents, A.scopeList(scopesNow()));
      let path = '/';
      try { path = new URL(req.url).pathname; } catch (e) { path = A.urlRaw(f.item.request.url).replace(/^\{\{[^}]+\}\}/, '').split('?')[0] || '/'; }
      S.mocks.unshift(A.newMock({ name: p.label + ': ' + f.item.name, method: f.item.request.method, path, status: p.status || 200, delay: p.delay || 0, body: p.body == null ? '' : p.body, headers: p.headers || '{}', network: p.network || '' }));
      S.mockMode = true;
      save(); renderMocks(); P.renderMockToggle();
      toast('Сбой «' + p.label + '» для ' + f.item.request.method + ' ' + path + ' — моки включены');
    } })));
  }

  /* ---------- инициализация ---------- */
  window.ATA_UI = {
    init() { initGen(); initFailPresets(); refreshSelectors(); renderSpec(); renderMocks(); renderRunTable(); renderAnalysis(); },
    refreshSelectors, runFolder, contractForRun, addAdHocResult, renderMocks, renderSpec,
    onTab_contract: renderContractResults,
    onTab_analysis: renderAnalysis,
    onTab_generate: () => requestOptions($('#genSource'), true),
    onTab_load: () => requestOptions($('#loadSource'), true),
  };
})();
