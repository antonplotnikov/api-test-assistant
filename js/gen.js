/* Анализ падений, баг-репорты, генерация тест-кейсов, OpenAPI → коллекция, моки из ответов/спеки. */
(function (G) {
  'use strict';
  const ATA = (G.ATA = G.ATA || {});
  const q = (s) => JSON.stringify(s);

  /* ---------- конструктор проверок → код pm ---------- */
  const ASSERTION_TYPES = {
    status: { label: 'Статус равен', ph: '200', code: (v) => 'pm.test(' + q('Статус ' + v) + ', function () {\n    pm.response.to.have.status(' + (Number(v) || 200) + ');\n});' },
    statusIn: { label: 'Статус один из', ph: '400,422', code: (v) => 'pm.test(' + q('Статус один из ' + v) + ', function () {\n    pm.expect(pm.response.code).to.be.oneOf([' + v.split(',').map((x) => Number(x.trim())).filter(Boolean).join(', ') + ']);\n});' },
    not5xx: { label: 'Нет 5xx', ph: '', code: () => 'pm.test("Сервер не упал (нет 5xx)", function () {\n    pm.expect(pm.response.code).to.be.below(500);\n});' },
    time: { label: 'Время ответа меньше, мс', ph: '1000', code: (v) => 'pm.test(' + q('Время ответа < ' + (Number(v) || 1000) + ' мс') + ', function () {\n    pm.expect(pm.response.responseTime).to.be.below(' + (Number(v) || 1000) + ');\n});' },
    header: { label: 'Есть заголовок', ph: 'Content-Type', code: (v) => 'pm.test(' + q('Есть заголовок ' + v) + ', function () {\n    pm.response.to.have.header(' + q(v) + ');\n});' },
    json: { label: 'Ответ — JSON', ph: '', code: () => 'pm.test("Ответ в формате JSON", function () {\n    pm.response.to.be.json;\n});' },
    jsonEq: { label: 'JSON-путь = значение', ph: 'data.id = 1', code: (v) => {
      const i = v.indexOf('=');
      const path = (i >= 0 ? v.slice(0, i) : v).trim();
      let val = i >= 0 ? v.slice(i + 1).trim() : '';
      try { JSON.parse(val); } catch (e) { val = q(val); }
      return 'pm.test(' + q(path + ' = ' + (i >= 0 ? v.slice(i + 1).trim() : '')) + ', function () {\n    pm.response.to.have.jsonBody(' + q(path) + ', ' + val + ');\n});';
    } },
    jsonHas: { label: 'JSON-путь существует', ph: 'data.items', code: (v) => 'pm.test(' + q('Есть поле ' + v) + ', function () {\n    pm.response.to.have.jsonBody(' + q(v) + ');\n});' },
    bodyHas: { label: 'Тело содержит текст', ph: 'success', code: (v) => 'pm.test(' + q('Тело содержит "' + v + '"') + ', function () {\n    pm.expect(pm.response.text()).to.include(' + q(v) + ');\n});' },
    saveVar: { label: 'Сохранить JSON-путь в переменную', ph: 'token = data.accessToken', code: (v) => {
      const i = v.indexOf('=');
      const name = (i >= 0 ? v.slice(0, i) : 'value').trim(), path = (i >= 0 ? v.slice(i + 1) : v).trim();
      return '// сохраняем значение для следующих запросов\nvar __json = pm.response.json();\npm.environment.set(' + q(name) + ', ' + path.split('.').reduce((acc, k) => acc + (/^\d+$/.test(k) ? '[' + k + ']' : /^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : '[' + q(k) + ']'), '__json') + ');';
    } },
    schema: { label: 'Совпадает со схемой из ответа', ph: '', code: (v, ctx) => {
      const schema = ctx && ctx.json !== undefined ? inferSchema(ctx.json) : { type: 'object' };
      return 'pm.test("Ответ соответствует схеме", function () {\n    var schema = ' + JSON.stringify(schema, null, 2).split('\n').join('\n    ') + ';\n    pm.response.to.have.jsonSchema(schema);\n});';
    } },
    snapshot: { label: 'Совпадает с эталоном (последний ответ)', ph: 'id, createdAt', code: (v, ctx) => snapshotCode(ctx && ctx.json, v) },
  };

  const SNAPSHOT_LIMIT = 100000;
  /**
   * Snapshot-проверка: эталон из ответа + список игнорируемых полей (id, даты и т.п.).
   * Код обычный JS без хелперов страницы — работает и в Postman / Newman.
   */
  function snapshotCode(json, ignoreList) {
    if (json === undefined) throw new Error('Нужен JSON-ответ: сначала отправьте запрос');
    const expected = JSON.stringify(json, null, 2);
    if (expected.length > SNAPSHOT_LIMIT) throw new Error('Ответ слишком большой для эталона (' + Math.round(expected.length / 1024) + ' КБ > ' + SNAPSHOT_LIMIT / 1000 + ' КБ) — проверьте часть ответа через JSON-путь или схему');
    const ignore = String(ignoreList || '').split(',').map((s) => s.trim()).filter(Boolean);
    return [
      'pm.test("Ответ совпадает с эталоном", function () {',
      '    var expected = ' + expected.split('\n').join('\n    ') + ';',
      '    var ignore = ' + JSON.stringify(ignore) + '; // поля, которые меняются от запуска к запуску',
      '    var diffs = [];',
      '    function cmp(actual, exp, path) {',
      '        if (actual === exp) return;',
      '        var bothObj = actual && exp && typeof actual === "object" && typeof exp === "object" && Array.isArray(actual) === Array.isArray(exp);',
      '        if (!bothObj) { diffs.push(path + ": ожидалось " + JSON.stringify(exp) + ", получено " + JSON.stringify(actual)); return; }',
      '        if (Array.isArray(exp) && actual.length !== exp.length) diffs.push(path + ": элементов " + actual.length + " вместо " + exp.length);',
      '        Object.keys(exp).forEach(function (k) {',
      '            if (ignore.indexOf(k) !== -1) return;',
      '            var p = Array.isArray(exp) ? path + "[" + k + "]" : path + "." + k;',
      '            if (!(k in actual)) diffs.push(p + ": поле пропало");',
      '            else cmp(actual[k], exp[k], p);',
      '        });',
      '        if (!Array.isArray(exp)) Object.keys(actual).forEach(function (k) {',
      '            if (!(k in exp) && ignore.indexOf(k) === -1) diffs.push(path + "." + k + ": новое поле");',
      '        });',
      '    }',
      '    cmp(pm.response.json(), expected, "$");',
      '    pm.expect(diffs, "Отличия от эталона: " + diffs.slice(0, 5).join("; ") + (diffs.length > 5 ? " (+" + (diffs.length - 5) + ")" : "")).to.be.empty;',
      '});',
    ].join('\n');
  }

  /**
   * Структурный diff двух JSON: [{path, kind: 'changed'|'type'|'missing'|'added'|'length', a, b}]
   * ignore — имена полей, которые не сравниваются (id, даты…). limit — максимум отличий.
   */
  function diffJson(a, b, opts) {
    opts = opts || {};
    const ignore = new Set(opts.ignore || []);
    const limit = opts.limit || 200;
    const out = [];
    const t = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    (function walk(x, y, path) {
      if (out.length >= limit || x === y) return;
      const tx = t(x), ty = t(y);
      if (tx !== ty) { out.push({ path, kind: 'type', a: x, b: y }); return; }
      if (tx !== 'object' && tx !== 'array') { if (x !== y) out.push({ path, kind: 'changed', a: x, b: y }); return; }
      if (tx === 'array') {
        if (x.length !== y.length) out.push({ path, kind: 'length', a: x.length, b: y.length });
        for (let i = 0; i < Math.min(x.length, y.length, 50); i++) walk(x[i], y[i], path + '[' + i + ']');
        return;
      }
      const keys = new Set(Object.keys(x).concat(Object.keys(y)));
      for (const k of keys) {
        if (ignore.has(k)) continue;
        const p = path + (/^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
        if (!(k in y)) out.push({ path: p, kind: 'missing', a: x[k] });
        else if (!(k in x)) out.push({ path: p, kind: 'added', b: y[k] });
        else walk(x[k], y[k], p);
      }
    })(a, b, '$');
    return out;
  }

  /* ---------- поток переменных ---------- */
  const SET_RE = /(?:pm\.(?:environment|collectionVariables|variables|globals)\.set|postman\.set(?:Environment|Global)Variable)\(\s*(['"`])([^'"`]+)\1/g;
  const GET_RE = /(?:pm\.(?:environment|collectionVariables|variables|globals|iterationData)\.get|postman\.get(?:Environment|Global)Variable)\(\s*(['"`])([^'"`]+)\1/g;
  const namesIn = (re, code) => Array.from(String(code || '').matchAll(re)).map((m) => m[2]);

  /**
   * Где переменные задаются и где используются, в порядке запуска коллекции.
   * known: {env: Map, coll: Map, data: Set} → {vars:[{name, source, setBy, usedBy, issues}], issues:[...]}
   */
  function analyzeVarFlow(c, known) {
    known = known || {};
    const env = known.env || new Map(), coll = known.coll || new Map(), data = known.data || new Set();
    const vars = new Map();
    const V = (n) => { if (!vars.has(n)) vars.set(n, { name: n, setBy: [], usedBy: [] }); return vars.get(n); };
    const addOnce = (list, ref) => { if (!list.some((x) => x.id === ref.id && x.where === ref.where)) list.push(ref); };
    const both = (node) => ATA.scriptOf(node, 'prerequest') + '\n' + ATA.scriptOf(node, 'test');
    namesIn(SET_RE, both(c)).forEach((n) => addOnce(V(n).setBy, { id: '__coll', name: 'скрипт коллекции', order: -1, where: 'collection' }));
    let order = 0;
    ATA.eachRequest(c.item, (it, parents) => {
      order++;
      parents.forEach((p) => namesIn(SET_RE, both(p)).forEach((n) => { const ex = V(n).setBy.find((x) => x.id === p._id); if (!ex) V(n).setBy.push({ id: p._id, name: 'папка «' + p.name + '»', order: order - 0.5, where: 'folder' }); }));
      const ref = { id: it._id, name: it.name, method: it.request.method, order };
      // один запрос — одна запись в «используют», даже если переменная и в URL, и в скрипте
      const use = (n, where) => { const list = V(n).usedBy; if (!list.some((x) => x.id === ref.id)) list.push(Object.assign({ where }, ref)); };
      ATA.varNames(c, it, parents).filter((n) => !ATA.isDynamicVar(n)).forEach((n) => use(n, 'request'));
      const testSets = new Set(namesIn(SET_RE, ATA.scriptOf(it, 'test')));
      // чтение в том же Tests-скрипте, который переменную ставит (например, console.log), — не потребитель
      namesIn(GET_RE, ATA.scriptOf(it, 'prerequest')).forEach((n) => use(n, 'script'));
      namesIn(GET_RE, ATA.scriptOf(it, 'test')).filter((n) => !testSets.has(n)).forEach((n) => use(n, 'script'));
      namesIn(SET_RE, ATA.scriptOf(it, 'prerequest')).forEach((n) => addOnce(V(n).setBy, Object.assign({}, ref, { order: order - 0.25, where: 'pre-request' })));
      testSets.forEach((n) => addOnce(V(n).setBy, Object.assign({}, ref, { order: order + 0.25, where: 'tests' })));
    });
    const issues = [];
    for (const v of vars.values()) {
      v.source = env.has(v.name) ? 'env' : coll.has(v.name) ? 'collection' : data.has(v.name) ? 'data' : v.setBy.length ? 'script' : null;
      v.issues = [];
      const staticVal = env.has(v.name) ? env.get(v.name) : coll.has(v.name) ? coll.get(v.name) : undefined;
      if (v.usedBy.length && !v.source) v.issues.push({ sev: 'error', text: 'Не задана нигде: нет ни в окружении, ни в переменных коллекции, и ни один скрипт её не ставит' });
      else if (v.source === 'script') {
        const firstSet = Math.min(...v.setBy.map((s) => s.order));
        const setter = v.setBy.find((s) => s.order === firstSet);
        const early = v.usedBy.filter((u) => u.order < firstSet);
        if (early.length) v.issues.push({ sev: 'warn', text: 'Используется в «' + early[0].name + '»' + (early.length > 1 ? ' и ещё ' + (early.length - 1) : '') + ' раньше, чем её ставит ' + (setter.where === 'folder' || setter.where === 'collection' ? setter.name : '«' + setter.name + '»') + ' — при запуске по порядку там будет пусто' });
      }
      if ((v.source === 'env' || v.source === 'collection') && staticVal === '' && !v.setBy.length && v.usedBy.length) v.issues.push({ sev: 'warn', text: 'Задана, но значение пустое' + (v.source === 'env' ? ' (секреты не сохраняются после перезагрузки — введите заново)' : '') });
      if (v.setBy.length && !v.usedBy.length) v.issues.push({ sev: 'info', text: 'Ставится, но нигде не используется' });
      v.issues.forEach((i) => issues.push(Object.assign({ var: v.name }, i)));
    }
    const rank = { error: 0, warn: 1, info: 2 };
    const list = Array.from(vars.values()).sort((a, b) => (a.issues.length ? rank[a.issues[0].sev] : 3) - (b.issues.length ? rank[b.issues[0].sev] : 3) || a.name.localeCompare(b.name));
    issues.sort((a, b) => rank[a.sev] - rank[b.sev]);
    return { vars: list, issues };
  }

  /* ---------- история и сравнение прогонов ---------- */
  const runKey = (r) => r.id + '#' + (r.iteration || 0);

  /** Сжатая запись прогона для истории (без тел ответов). */
  function summarizeRun(results, meta) {
    return Object.assign({ at: Date.now(), total: results.length, passed: results.filter((r) => r.pass).length }, meta || {}, {
      items: results.map((r) => ({ key: runKey(r), name: r.name, method: r.request ? r.request.method : '', pass: !!r.pass, code: r.response ? r.response.code : r.error ? r.error.kind : null, ms: r.response ? r.response.timeMs : null, failed: (r.tests || []).filter((t) => !t.pass).map((t) => t.name).slice(0, 5) })),
    });
  }

  /**
   * Сравнение двух прогонов (prev, cur — записи summarizeRun).
   * → {newFail, fixed, slower, codeChanged, added, removed, byKey: {key: 'regression'|'fixed'|'slower'|'new'}}
   */
  function compareRuns(prev, cur, opts) {
    opts = opts || {};
    const ratio = opts.slowRatio || 1.5, minDelta = opts.slowMinMs || 100;
    const pm = new Map(prev.items.map((x) => [x.key, x]));
    const cm = new Map(cur.items.map((x) => [x.key, x]));
    const out = { newFail: [], fixed: [], slower: [], codeChanged: [], added: [], removed: [], byKey: {} };
    for (const c of cur.items) {
      const p = pm.get(c.key);
      if (!p) { out.added.push(c); out.byKey[c.key] = 'new'; continue; }
      if (p.pass && !c.pass) { out.newFail.push({ prev: p, cur: c }); out.byKey[c.key] = 'regression'; }
      else if (!p.pass && c.pass) { out.fixed.push({ prev: p, cur: c }); out.byKey[c.key] = 'fixed'; }
      if (p.code !== c.code) out.codeChanged.push({ prev: p, cur: c });
      if (typeof p.ms === 'number' && typeof c.ms === 'number' && c.ms > p.ms * ratio && c.ms - p.ms > minDelta) {
        out.slower.push({ prev: p, cur: c });
        if (!out.byKey[c.key]) out.byKey[c.key] = 'slower';
      }
    }
    for (const p of prev.items) if (!cm.has(p.key)) out.removed.push(p);
    return out;
  }

  /* ---------- отчёты ---------- */
  const xmlEsc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

  /** JUnit XML: один testsuite на папку, testcase на каждую проверку (или на запрос без проверок). */
  function junitXml(results, suiteName) {
    const suites = new Map();
    results.forEach((r) => {
      const name = r.folder || suiteName || 'Коллекция';
      if (!suites.has(name)) suites.set(name, []);
      const cls = (r.request ? r.request.method + ' ' : '') + r.name + (r.iteration ? ' [итерация ' + (r.iteration + 1) + ']' : '');
      const time = ((r.response ? r.response.timeMs : r.error && r.error.timeMs) || 0) / 1000;
      const cases = suites.get(name);
      if (r.error) cases.push({ cls, name: 'Запрос выполнен', time, failure: { type: r.error.kind, message: r.error.message } });
      else if (!r.tests.length) cases.push({ cls, name: 'Ответ получен (' + r.response.code + ')', time });
      r.tests.forEach((t) => cases.push({ cls, name: t.name, time: 0, failure: t.pass ? null : { type: t.unsupported ? 'unsupported' : 'assertion', message: t.message }, skipped: t.skipped }));
      (r.scriptErrors || []).forEach((e) => cases.push({ cls, name: 'Скрипт ' + e.where, time: 0, failure: { type: 'script', message: e.name + ': ' + e.message } }));
      if (r.contract) {
        const errs = r.contract.issues.filter((i) => i.kind !== 'extra-warn' && i.kind !== 'undocumented');
        cases.push({ cls, name: 'Контракт', time: 0, failure: errs.length ? { type: 'contract', message: errs.slice(0, 10).map((i) => i.path + ' ' + i.message).join('\n') } : null });
      }
    });
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
    let all = 0, allFail = 0;
    const body = [];
    for (const [name, cases] of suites) {
      const fails = cases.filter((c) => c.failure).length;
      all += cases.length; allFail += fails;
      body.push('  <testsuite name="' + xmlEsc(name) + '" tests="' + cases.length + '" failures="' + fails + '" skipped="' + cases.filter((c) => c.skipped).length + '" time="' + cases.reduce((s, c) => s + c.time, 0).toFixed(3) + '">');
      cases.forEach((c) => {
        const open = '    <testcase classname="' + xmlEsc(c.cls) + '" name="' + xmlEsc(c.name) + '" time="' + c.time.toFixed(3) + '"';
        if (c.failure) body.push(open + '>', '      <failure type="' + xmlEsc(c.failure.type) + '" message="' + xmlEsc(String(c.failure.message).split('\n')[0]) + '">' + xmlEsc(c.failure.message) + '</failure>', '    </testcase>');
        else if (c.skipped) body.push(open + '><skipped/></testcase>');
        else body.push(open + '/>');
      });
      body.push('  </testsuite>');
    }
    lines.push('<testsuites name="' + xmlEsc(suiteName || 'API tests') + '" tests="' + all + '" failures="' + allFail + '">', ...body, '</testsuites>');
    return lines.join('\n');
  }

  const htmlEsc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  /** Самодостаточный HTML-отчёт: открывается без интернета, можно приложить к задаче. */
  function htmlReport(results, meta) {
    meta = meta || {};
    const total = results.length, passed = results.filter((r) => r.pass).length;
    const times = results.filter((r) => r.response).map((r) => r.response.timeMs);
    const st = ATA.stats(times);
    const row = (r, i) => {
      const t = r.tests || [];
      const a = r.pass ? null : analyze(r);
      const details = [];
      t.forEach((x) => details.push('<li class="' + (x.pass ? 'ok' : 'fail') + '">' + (x.pass ? '✓ ' : '✗ ') + htmlEsc(x.name) + (x.message ? ' — <span class="m">' + htmlEsc(x.message) + '</span>' : '') + '</li>'));
      if (a) a.findings.filter((f) => f.category !== 'Проверка').forEach((f) => details.push('<li class="fail">⚠ <b>' + htmlEsc(f.title) + '</b><div class="m">' + htmlEsc(f.why) + '</div></li>'));
      return '<tr class="' + (r.pass ? 'ok' : 'fail') + '"><td>' + (i + 1) + '</td><td><b>' + htmlEsc(r.request ? r.request.method : '') + '</b> ' + htmlEsc(r.name) + (r.folder ? '<div class="m">' + htmlEsc(r.folder) + '</div>' : '') + (details.length ? '<details' + (r.pass ? '' : ' open') + '><summary>проверки</summary><ul>' + details.join('') + '</ul></details>' : '') + '</td><td>' + (r.response ? r.response.code : htmlEsc(r.error ? r.error.kind : '—')) + '</td><td class="n">' + (r.response ? r.response.timeMs + ' мс' : '—') + '</td><td class="n">' + t.filter((x) => x.pass).length + '/' + t.length + '</td><td>' + (r.pass ? '✅' : '❌') + '</td></tr>';
    };
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + htmlEsc(meta.title || 'Отчёт API-тестов') + '</title><style>' +
      ':root{--bg:#fff;--text:#1c2330;--muted:#5d6878;--line:#dfe3e8;--ok:#1f8a4c;--fail:#c93636;--panel:#f3f5f8}' +
      '@media (prefers-color-scheme:dark){:root{--bg:#12161c;--text:#e4e8ee;--muted:#9aa5b5;--line:#2f3744;--ok:#4cc47e;--fail:#f07070;--panel:#1a1f27}}' +
      'body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto}' +
      'h1{font-size:20px;margin:0 0 4px}.meta{color:var(--muted);margin-bottom:16px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}' +
      '.card{background:var(--panel);border-radius:8px;padding:10px 12px}.card b{display:block;font-size:22px}.card span{color:var(--muted);font-size:12px}' +
      '.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:12px}' +
      '.n{text-align:right;white-space:nowrap}tr.fail td:first-child{border-left:3px solid var(--fail)}tr.ok td:first-child{border-left:3px solid var(--ok)}' +
      'ul{margin:6px 0;padding-left:18px}li.ok{color:var(--ok)}li.fail{color:var(--fail)}.m{color:var(--muted);font-size:12.5px;white-space:pre-wrap}summary{cursor:pointer;color:var(--muted);font-size:12.5px}' +
      '</style></head><body><main><h1>' + htmlEsc(meta.title || 'Отчёт о прогоне API-тестов') + '</h1><div class="meta">' + htmlEsc(new Date(meta.at || Date.now()).toLocaleString()) + ' · окружение: ' + htmlEsc(meta.env || '—') + '</div>' +
      '<div class="cards"><div class="card"><b>' + total + '</b><span>запросов</span></div><div class="card"><b style="color:var(--ok)">' + passed + '</b><span>успешно</span></div><div class="card"><b style="color:' + (total - passed ? 'var(--fail)' : 'var(--ok)') + '">' + (total - passed) + '</b><span>упало</span></div><div class="card"><b>' + Math.round(st.avg) + ' мс</b><span>среднее время</span></div><div class="card"><b>' + st.p95 + ' мс</b><span>p95</span></div></div>' +
      '<div class="wrap"><table><tr><th>#</th><th>Запрос</th><th>Статус</th><th>Время</th><th>Проверки</th><th>Итог</th></tr>' + results.map(row).join('') + '</table></div></main></body></html>';
  }

  /** Схема по образцу ответа (для быстрой фиксации контракта). */
  function inferSchema(v, depth) {
    depth = depth || 0;
    const t = ATA.typeOf(v);
    if (depth > 6) return {};
    if (t === 'object') {
      const props = {};
      Object.keys(v).forEach((k) => { props[k] = inferSchema(v[k], depth + 1); });
      return { type: 'object', required: Object.keys(v), properties: props };
    }
    if (t === 'array') return v.length ? { type: 'array', items: inferSchema(v[0], depth + 1) } : { type: 'array' };
    if (t === 'null') return {};
    return { type: t };
  }

  /* ---------- анализ падений ---------- */
  function pick(json, keys) {
    if (!json || typeof json !== 'object') return null;
    for (const k of keys) if (json[k]) return typeof json[k] === 'string' ? json[k] : JSON.stringify(json[k]).slice(0, 200);
    return null;
  }

  /**
   * analyze(result, opts) → {verdict, findings:[{sev:'error'|'warn'|'info', title, why, steps[]}], category}
   */
  function analyze(r, opts) {
    opts = opts || {};
    const F = [];
    const add = (sev, category, title, why, steps) => F.push({ sev, category, title, why, steps: steps || [] });
    const req = r.request || {};
    const resp = r.response;
    const hdr = (n) => (req.headers || []).find(([k]) => k.toLowerCase() === n.toLowerCase());
    const pageHttps = typeof location !== 'undefined' && location.protocol === 'https:';

    if (req.unresolved && req.unresolved.length) {
      add(r.error && r.error.kind === 'unresolved' ? 'error' : 'warn', 'Переменные', 'Не подставлены переменные: ' + req.unresolved.map((u) => '{{' + u + '}}').join(', '),
        'В окружении и в переменных коллекции нет этих ключей, поэтому в запрос ушёл текст {{…}}.',
        ['Выберите нужное окружение в шапке страницы', 'Добавьте переменные во вкладке «Коллекция → Переменные»', 'Если значение ставит другой запрос (например, токен после логина) — запустите его раньше']);
    }

    if (r.error) {
      const e = r.error;
      if (e.kind === 'timeout') add('error', 'Таймаут', e.message, 'Сервер не ответил вовремя: он перегружен, запрос «завис» на тяжёлой операции, или порт/хост недоступен и соединение висит.',
        ['Повторите запрос — если стабильно, это не случайность', 'Увеличьте таймаут в настройках, чтобы узнать реальное время ответа', 'Проверьте хост из терминала: скопируйте cURL и выполните', 'Посмотрите логи/метрики сервиса за это время']);
      else if (e.kind === 'network') {
        const steps = [];
        let why = 'Браузер не получил ответ. Типичные причины: сервер не отдаёт CORS-заголовки для этой страницы, хост недоступен/DNS не резолвится, самоподписанный сертификат, или блокировщик рекламы.';
        if (pageHttps && /^http:/i.test(req.url)) { why = 'Страница открыта по HTTPS, а запрос идёт по HTTP — браузер блокирует mixed content.'; steps.push('Используйте https:// в baseUrl или откройте страницу локально через http://localhost'); }
        if (e.mocked) why = 'Сетевую ошибку имитирует правило мока.';
        steps.push('Выполните запрос через cURL — если там работает, проблема в CORS', 'Включите CORS-прокси в настройках (только для тестовых стендов)', 'Или запустите коллекцию через Newman / Postman CLI — там CORS нет', 'Откройте DevTools → Console: браузер пишет точную причину');
        add('error', 'Сеть / CORS', 'Сетевая ошибка: ' + e.message, why, steps);
      } else if (e.kind === 'unresolved') { /* уже добавлено выше */ }
      else add('error', 'Ошибка', e.message || String(e.kind), '', []);
    }

    if (resp) {
      const c = resp.code;
      const msg = pick(resp.json, ['message', 'error', 'detail', 'error_description', 'title', 'errors']) || (resp.json === undefined && resp.text ? resp.text.slice(0, 160) : null);
      const serverSays = msg ? 'Сервер ответил: «' + msg + '». ' : '';
      if (c === 401) {
        const hasAuth = hdr('Authorization') || req.authType;
        add('error', 'Авторизация', '401 Unauthorized — ' + (hasAuth ? 'токен не принят' : 'запрос ушёл без авторизации'),
          serverSays + (hasAuth ? 'Токен просрочен, выдан для другого окружения или имеет неверный формат (например, нет префикса Bearer).' : 'Ни заголовка Authorization, ни настроенной авторизации у запроса/папки/коллекции нет.'),
          hasAuth ? ['Получите свежий токен (запрос логина) и проверьте переменную токена', 'Сверьте окружение: токен с dev не подойдёт к stage', 'Проверьте формат заголовка: Authorization: Bearer <token>'] : ['Задайте авторизацию на вкладке «Auth» запроса или у коллекции', 'Если токен ставит скрипт логина — запустите его первым']);
      } else if (c === 403) add('error', 'Права доступа', '403 Forbidden — доступ запрещён', serverSays + 'Пользователь аутентифицирован, но у него нет прав на ресурс/действие, либо сработал WAF/CSRF/фильтр по IP.', ['Проверьте роль/скоупы токена', 'Сравните с запросом от пользователя с правами администратора', 'Проверьте, что ресурс принадлежит этому пользователю']);
      else if (c === 404) {
        const path = (() => { try { return new URL(req.url).pathname; } catch (e) { return req.url; } })();
        const bad = /\/(undefined|null|NaN)(\/|$)|\/\//.test(path);
        add('error', 'Ресурс не найден', '404 Not Found — ' + path, serverSays + (bad ? 'В пути есть «undefined/null» или «//» — пустая переменная подставилась в URL.' : 'Неверный путь/версия API, неверный baseUrl, либо объекта с таким id нет (удалён или из другого окружения).'),
          ['Сверьте путь с документацией/OpenAPI (вкладка «Контракт» покажет, описан ли путь)', 'Проверьте baseUrl и префикс версии (/v1, /api)', 'Проверьте, что id существует: получите его списком', bad ? 'Найдите, какая переменная пустая, и задайте её' : 'Если ресурс только что создан — возможно, запись ещё не реплицировалась']);
      } else if (c === 405) add('error', 'Метод', '405 Method Not Allowed', serverSays + 'Эндпоинт существует, но не принимает метод ' + req.method + '.', ['Проверьте метод по документации', 'Проверьте заголовок Allow в ответе: ' + ((resp.headers.find(([k]) => k === 'allow') || [])[1] || '—')]);
      else if (c === 400 || c === 422) {
        const steps = ['Сравните тело с примером из документации'];
        let why = serverSays + 'Сервер отверг данные запроса: не хватает обязательного поля, неверный тип или формат значения.';
        if (typeof req.body === 'string' && /json/i.test((hdr('Content-Type') || [])[1] || '')) {
          try { JSON.parse(req.body); } catch (e) { why = 'Тело запроса — невалидный JSON (' + e.message + '). ' + serverSays; steps.unshift('Исправьте JSON в теле запроса'); }
        }
        if (req.body && !hdr('Content-Type')) steps.push('Добавьте заголовок Content-Type');
        steps.push('Если это негативный тест — проверьте, что такой ответ и ожидается');
        add(opts.expectedClientError ? 'info' : 'error', 'Данные запроса', c + ' ' + resp.status + ' — запрос не прошёл валидацию', why, steps);
      } else if (c === 409) add('error', 'Конфликт', '409 Conflict', serverSays + 'Конфликт состояния: дубликат уникального поля или устаревшая версия объекта.', ['Используйте уникальные значения ({{$guid}}, {{$timestamp}})', 'Удалите тестовые данные от прошлых прогонов']);
      else if (c === 415) add('error', 'Формат тела', '415 Unsupported Media Type', 'Сервер не принимает Content-Type «' + (((hdr('Content-Type') || [])[1]) || 'не указан') + '».', ['Укажите Content-Type: application/json', 'Проверьте режим тела (raw JSON / form)']);
      else if (c === 429) add('warn', 'Лимит запросов', '429 Too Many Requests', 'Сработал rate limit. Retry-After: ' + (((resp.headers.find(([k]) => k === 'retry-after') || [])[1]) || 'не указан') + '.', ['Добавьте задержку между запросами в раннере', 'Снизьте параллельность в нагрузке', 'Уточните лимиты для тестового ключа']);
      else if (c >= 500) {
        const why = { 500: 'Необработанное исключение на сервере — это почти всегда баг бэкенда.', 501: 'Метод не реализован' + (resp.mocked ? ' (нет подходящего правила мока).' : '.'), 502: 'Шлюз/балансировщик получил некорректный ответ от сервиса (сервис упал или перезапускается).', 503: 'Сервис недоступен: деплой, перегрузка или техработы.', 504: 'Шлюз не дождался ответа сервиса (медленный запрос к БД/внешнему API).' }[c] || 'Ошибка на стороне сервера.';
        add('error', 'Ошибка сервера', c + ' ' + resp.status, serverSays + why, ['Повторите запрос — плавающая или стабильная?', 'Сохраните время запроса и correlation/trace id из заголовков: ' + (resp.headers.filter(([k]) => /request-id|trace|correlation/i.test(k)).map(([k, v]) => k + '=' + v).join(', ') || 'не найдены'), 'Сравните с минимальным валидным телом — какое поле ломает сервер', 'Заведите баг: 5xx на пользовательском вводе недопустим']);
      }

      if (resp.json === undefined && /json/i.test(resp.contentType || '') && resp.text) add('error', 'Формат ответа', 'Content-Type JSON, но тело не парсится', 'Сервер заявил JSON, но вернул что-то другое (HTML страницу ошибки, обрезанный ответ).', ['Посмотрите сырое тело ответа', 'Проверьте, не вернул ли прокси/шлюз HTML-ошибку']);
      if (resp.redirected) add('info', 'Редирект', 'Был редирект → ' + resp.finalUrl, 'fetch автоматически прошёл по редиректу. Если это страница логина — запрос не авторизован.', []);
      const slow = opts.slowMs || 2000;
      if (resp.timeMs > slow) add('warn', 'Производительность', 'Медленный ответ: ' + resp.timeMs + ' мс', 'Ответ дольше порога ' + slow + ' мс.', ['Запустите нагрузку на этот запрос и посмотрите p95', 'Проверьте размер ответа: ' + Math.round(resp.size / 1024) + ' КБ — нужна ли пагинация?']);
    }

    (r.tests || []).filter((t) => !t.pass).forEach((t) => {
      add(t.unsupported ? 'warn' : 'error', t.unsupported ? 'Скрипт' : 'Проверка', (t.unsupported ? 'Не поддерживается: ' : 'Упала проверка: ') + t.name, t.message,
        t.unsupported ? ['Эта функция Postman не работает в браузере — прогоните через Newman / Postman CLI'] : explainAssertion(t.message, resp));
    });
    (r.scriptErrors || []).forEach((e) => add(e.unsupported ? 'warn' : 'error', 'Скрипт', 'Ошибка в скрипте ' + e.where, e.name + ': ' + e.message, e.unsupported ? ['Функция не поддерживается браузерным раннером — используйте Newman / Postman CLI'] : ['Исправьте скрипт на вкладке «Скрипты»']));
    if (r.contract) {
      const errs = r.contract.issues.filter((i) => i.kind !== 'extra-warn');
      const warns = r.contract.issues.filter((i) => i.kind === 'extra-warn');
      if (errs.length) add(errs[0].kind === 'undocumented' ? 'warn' : 'error', 'Контракт', 'Нарушение контракта: ' + errs.length, errs.slice(0, 5).map((i) => (i.path ? i.path + ': ' : '') + i.message).join('\n') + (errs.length > 5 ? '\n…ещё ' + (errs.length - 5) : ''), ['Если поведение верное — обновите спецификацию', 'Если спецификация верна — заведите баг на бэкенд']);
      if (warns.length) add('info', 'Контракт', 'Необъявленные поля: ' + warns.length, warns.slice(0, 5).map((i) => i.path).join(', '), ['Поле есть в ответе, но не описано в схеме — проверьте, не утекают ли лишние данные']);
    }

    const verdict = r.pass ? 'pass' : F.some((f) => f.sev === 'error') ? 'fail' : 'warn';
    return { verdict, findings: F, category: (F.find((f) => f.sev === 'error') || F[0] || {}).category || (r.pass ? 'OK' : 'Проверка') };
  }

  function explainAssertion(message, resp) {
    const m = /ожидался статус (\d+), получен (\d+)/.exec(message || '') || /expected (\d{3}) to (?:deeply )?equal (\d{3})/.exec(message || '');
    if (m) {
      const [want, got] = message.startsWith('ожидался') ? [m[1], m[2]] : [m[2], m[1]];
      const tips = ['Ожидали ' + want + ', получили ' + got + '.'];
      if (want[0] === '2' && got[0] === '2') tips.push('Оба успешные: возможно, изменился контракт (например, 200 → 201 для создания) — уточните у разработчиков');
      else if (got[0] === '4') tips.push('Смотрите подсказку по коду ' + got + ' выше');
      return tips;
    }
    if (/below/.test(message || '')) return ['Ответ медленнее порога — проверьте, единичный ли это случай, запустив нагрузку'];
    if (/property|jsonBody|в JSON нет/.test(message || '')) return ['Поле отсутствует или переименовано — сравните ответ с документацией', resp && resp.json !== undefined ? 'Ключи верхнего уровня: ' + Object.keys(resp.json || {}).slice(0, 12).join(', ') : 'Тело ответа не JSON'];
    return ['Сравните фактическое значение с ожидаемым; если ожидание устарело — обновите проверку'];
  }

  /** Баг-репорт в Markdown. */
  function bugReport(r, a, envName) {
    const req = r.request || {};
    const resp = r.response;
    const lines = [];
    const main = a.findings.find((f) => f.sev === 'error') || a.findings[0] || { title: 'Проверка не прошла' };
    lines.push('## ' + req.method + ' ' + shortPath(req.url) + ': ' + main.title, '');
    lines.push('**Окружение:** ' + (envName || '—') + '  ', '**Время:** ' + new Date(r.startedAt || Date.now()).toLocaleString() + '  ', '**Запрос в коллекции:** ' + (r.folder ? r.folder + ' / ' : '') + r.name, '');
    lines.push('### Шаги воспроизведения', '```bash', ATA.toCurl(maskReq(req)), '```', '');
    lines.push('### Ожидаемый результат');
    const failed = (r.tests || []).filter((t) => !t.pass);
    lines.push(failed.length ? failed.map((t) => '- ' + t.name).join('\n') : '- Успешный ответ без ошибок', '');
    lines.push('### Фактический результат');
    if (resp) {
      lines.push('- Статус: **' + resp.code + ' ' + resp.status + '**, время ' + resp.timeMs + ' мс');
      failed.forEach((t) => lines.push('- ✗ ' + t.name + ': ' + t.message));
      const ids = resp.headers.filter(([k]) => /request-id|trace|correlation/i.test(k));
      if (ids.length) lines.push('- ' + ids.map(([k, v]) => k + ': `' + v + '`').join(', '));
      lines.push('', '<details><summary>Тело ответа</summary>', '', '```json', (resp.json !== undefined ? JSON.stringify(resp.json, null, 2) : resp.text || '').slice(0, 3000), '```', '</details>');
    } else if (r.error) lines.push('- ' + r.error.message);
    lines.push('', '### Анализ');
    a.findings.forEach((f) => lines.push('- **' + f.title + '** — ' + (f.why || '').replace(/\n/g, '; ')));
    return lines.join('\n');
  }

  function shortPath(url) { try { const u = new URL(url); return u.pathname + u.search; } catch (e) { return url; } }

  /** Маскируем секреты в заголовках для отчётов. */
  function maskReq(req) {
    return Object.assign({}, req, { headers: (req.headers || []).map(([k, v]) => [k, /^(authorization|x-api-key|api-key|cookie|x-auth-token)$/i.test(k) ? v.replace(/(\S{4})\S+(\S{2})$/, '$1…$2') : v]) });
  }

  /* ---------- генерация тест-кейсов ---------- */
  const CASE_GROUPS = {
    positive: 'Позитивный',
    auth: 'Авторизация',
    body: 'Тело запроса',
    fields: 'Поля: обязательность и типы',
    boundary: 'Граничные значения',
    path: 'Параметры пути и query',
    robust: 'Устойчивость (спецсимволы, мусор)',
    security: 'Безопасность (IDOR, методы, секреты в URL)',
  };

  function testScript(lines) { return lines.join('\n\n'); }
  const T = ASSERTION_TYPES;

  function cloneItem(item, name, mutate, tests, group) {
    const it = ATA.clone(item);
    it._id = ATA.uid();
    delete it.response;
    it.name = name;
    it.event = (it.event || []).filter((e) => e.listen === 'prerequest');
    mutate && mutate(it.request, it);
    ATA.setScript(it, 'test', testScript(tests));
    it._group = group;
    return it;
  }

  function jsonBodyOf(item) {
    const b = item.request.body;
    if (!b || b.mode !== 'raw' || !b.raw) return undefined;
    try { return JSON.parse(b.raw); } catch (e) { return undefined; }
  }

  function setJsonBody(req, obj) {
    req.body = { mode: 'raw', raw: obj === undefined ? '' : JSON.stringify(obj, null, 2), options: { raw: { language: 'json' } } };
  }

  /** Плоский список листовых полей: [{path:[...], value}] */
  function leaves(obj, prefix, out, depth) {
    out = out || []; prefix = prefix || []; depth = depth || 0;
    if (depth > 4) return out;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      Object.keys(obj).forEach((k) => {
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) leaves(v, prefix.concat(k), out, depth + 1);
        else out.push({ path: prefix.concat(k), value: v });
      });
    }
    return out;
  }
  function setAt(obj, path, val, del) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
    if (del) delete cur[path[path.length - 1]];
    else cur[path[path.length - 1]] = val;
  }

  /**
   * generateCases(item, opts) → [item] — новые запросы с тестами.
   * opts: {groups:Set, okStatus, errorStatuses:'400,422', maxFields, spec}
   */
  function generateCases(item, opts) {
    opts = opts || {};
    // «Безопасность» шлёт DELETE/PUT на эндпоинты чтения — включается только явно
    const groups = opts.groups || new Set(Object.keys(CASE_GROUPS).filter((g) => g !== 'security'));
    const out = [];
    const method = item.request.method;
    const okStatus = opts.okStatus || (method === 'POST' ? 201 : 200);
    const err4 = opts.errorStatuses || '400,422';
    const neg = [T.statusIn.code(err4), T.not5xx.code()];
    const body = jsonBodyOf(item);
    const hasBody = body !== undefined;
    const base = item.name;
    const maxFields = opts.maxFields || 8;

    if (groups.has('positive')) {
      out.push(cloneItem(item, base + ' — позитивный', null, [T.status.code(String(okStatus)), T.time.code('2000'), T.not5xx.code()].concat(/GET|POST|PUT|PATCH/.test(method) ? [T.json.code()] : []), 'positive'));
    }
    if (groups.has('auth')) {
      out.push(cloneItem(item, base + ' — без авторизации', (r) => { r.auth = { type: 'noauth' }; r.header = (r.header || []).filter((h) => !/^(authorization|x-api-key|api-key|cookie)$/i.test(h.key)); }, [T.statusIn.code('401,403')], 'auth'));
      out.push(cloneItem(item, base + ' — неверный токен', (r) => { r.auth = { type: 'bearer', bearer: [{ key: 'token', value: 'invalid-token-' + Date.now().toString(36), type: 'string' }] }; r.header = (r.header || []).filter((h) => !/^authorization$/i.test(h.key)); }, [T.statusIn.code('401,403')], 'auth'));
    }
    if (groups.has('body') && /POST|PUT|PATCH/.test(method)) {
      out.push(cloneItem(item, base + ' — пустое тело', (r) => setJsonBody(r, undefined), [T.statusIn.code('400,415,422'), T.not5xx.code()], 'body'));
      out.push(cloneItem(item, base + ' — пустой объект {}', (r) => setJsonBody(r, {}), neg, 'body'));
      out.push(cloneItem(item, base + ' — невалидный JSON', (r) => { r.body = { mode: 'raw', raw: '{"broken": ', options: { raw: { language: 'json' } } }; }, [T.statusIn.code('400,422'), T.not5xx.code()], 'body'));
      out.push(cloneItem(item, base + ' — неверный Content-Type', (r) => { r.header = (r.header || []).filter((h) => !/^content-type$/i.test(h.key)).concat([{ key: 'Content-Type', value: 'text/plain' }]); }, [T.statusIn.code('400,415,422'), T.not5xx.code()], 'body'));
      if (Array.isArray(body) === false && hasBody) out.push(cloneItem(item, base + ' — массив вместо объекта', (r) => setJsonBody(r, [body]), neg, 'body'));
    }
    const fields = hasBody ? leaves(body).slice(0, maxFields) : [];
    const fname = (f) => f.path.join('.');
    if (groups.has('fields') && hasBody) {
      fields.forEach((f) => {
        const b1 = ATA.clone(body); setAt(b1, f.path, null, true);
        out.push(cloneItem(item, base + ' — без поля ' + fname(f), (r) => setJsonBody(r, b1), neg, 'fields'));
        const wrong = typeof f.value === 'number' ? 'not-a-number' : typeof f.value === 'boolean' ? 'yes' : typeof f.value === 'string' ? 12345 : 'string';
        const b2 = ATA.clone(body); setAt(b2, f.path, wrong);
        out.push(cloneItem(item, base + ' — неверный тип ' + fname(f) + ' (' + typeof wrong + ')', (r) => setJsonBody(r, b2), neg, 'fields'));
        const b3 = ATA.clone(body); setAt(b3, f.path, null);
        out.push(cloneItem(item, base + ' — ' + fname(f) + ' = null', (r) => setJsonBody(r, b3), neg, 'fields'));
      });
    }
    if (groups.has('boundary') && hasBody) {
      fields.forEach((f) => {
        const variants = [];
        if (typeof f.value === 'string') variants.push(['пустая строка', ''], ['пробелы', '   '], ['256 символов', 'a'.repeat(256)], ['10 000 символов', 'a'.repeat(10000)]);
        else if (typeof f.value === 'number') variants.push(['0', 0], ['-1', -1], ['дробное', 1.5], ['очень большое', 9007199254740993], ['2^31', 2147483648]);
        else if (Array.isArray(f.value)) variants.push(['пустой массив', []]);
        variants.forEach(([label, v]) => {
          const b = ATA.clone(body); setAt(b, f.path, v);
          out.push(cloneItem(item, base + ' — ' + fname(f) + ': ' + label, (r) => setJsonBody(r, b), [T.not5xx.code()], 'boundary'));
        });
      });
    }
    if (groups.has('path')) {
      const raw = ATA.urlRaw(item.request.url);
      const m = /^(.*\/)(\d+|\{\{[^}]+\}\}|[0-9a-f-]{36})(\/?(?:\?.*)?)$/i.exec(raw.split('#')[0]);
      if (m) {
        [['несуществующий id', '999999999', '404'], ['id = 0', '0', '400,404'], ['отрицательный id', '-1', '400,404'], ['id — строка', 'abc', '400,404'], ['id — SQL-строка', "1'%20OR%20'1'='1", '400,404']].forEach(([label, v, codes]) => {
          out.push(cloneItem(item, base + ' — ' + label, (r) => { r.url = m[1] + v + m[3]; }, [T.statusIn.code(codes), T.not5xx.code()], 'path'));
        });
      }
      const qi = raw.indexOf('?');
      if (qi !== -1) {
        const params = raw.slice(qi + 1).split('&').filter(Boolean);
        params.slice(0, 5).forEach((p, idx) => {
          const key = p.split('=')[0];
          out.push(cloneItem(item, base + ' — без query ' + key, (r) => { const rest = params.filter((_, j) => j !== idx).join('&'); r.url = raw.slice(0, qi) + (rest ? '?' + rest : ''); }, [T.not5xx.code()], 'path'));
          out.push(cloneItem(item, base + ' — query ' + key + ' = мусор', (r) => { r.url = raw.slice(0, qi) + '?' + params.map((x, j) => (j === idx ? key + '=%25%00%27%22%3C' : x)).join('&'); }, [T.not5xx.code()], 'path'));
        });
      }
    }
    if (groups.has('robust') && hasBody) {
      const strField = fields.find((f) => typeof f.value === 'string');
      if (strField) {
        [['SQL-инъекция', "' OR '1'='1' --"], ['XSS', '<script>alert(1)</script>'], ['Unicode/эмодзи', 'Тест 测试 🚀 ‮'], ['управляющие символы', 'a\u0000b\u0007c']].forEach(([label, v]) => {
          const b = ATA.clone(body); setAt(b, strField.path, v);
          out.push(cloneItem(item, base + ' — ' + label + ' в ' + fname(strField), (r) => setJsonBody(r, b), [T.not5xx.code(), 'pm.test("Значение не отражается без экранирования", function () {\n    pm.expect(pm.response.text()).to.not.include("<script>alert(1)</script>");\n});'], 'robust'));
        });
      }
      const extra = ATA.clone(body); if (extra && typeof extra === 'object' && !Array.isArray(extra)) { extra.isAdmin = true; extra.role = 'admin'; extra.__proto_test__ = 1; }
      out.push(cloneItem(item, base + ' — лишние поля (mass assignment)', (r) => setJsonBody(r, extra), [T.not5xx.code(), 'pm.test("Лишнее поле isAdmin не применилось", function () {\n    var j = {};\n    try { j = pm.response.json(); } catch (e) {}\n    pm.expect(j.isAdmin).to.not.equal(true);\n});'], 'robust'));
    }
    if (groups.has('security')) {
      const raw = ATA.urlRaw(item.request.url);
      const noLeak = 'pm.test("В ответе нет стектрейса и SQL-ошибок", function () {\n    pm.expect(pm.response.text()).to.not.match(/Traceback \\(most recent call last\\)|at [\\w.$]+ \\([^)]*:\\d+:\\d+\\)|SQLSTATE|SQLException|ORA-\\d{5}|syntax error at or near/);\n});';
      // IDOR / BOLA: соседний id другого пользователя должен быть недоступен
      const idm = /^(.*\/)(\d+)(\/?(?:\?.*)?)$/.exec(raw.split('#')[0]);
      if (idm) {
        const neighbor = String(Number(idm[2]) + 1);
        out.push(cloneItem(item, base + ' — IDOR: чужой id ' + neighbor, (r) => { r.url = idm[1] + neighbor + idm[3]; }, [
          '// Если ресурс с этим id принадлежит другому пользователю — ожидаем отказ.\n// Если id общедоступен по бизнес-логике, удалите этот кейс.',
          T.statusIn.code('403,404'), noLeak], 'security'));
      }
      // подмена метода: эндпоинт чтения не должен позволять изменять данные
      if (method === 'GET') {
        ['DELETE', 'PUT', 'PATCH'].forEach((m) => out.push(cloneItem(item, base + ' — метод ' + m + ' вместо GET', (r) => { r.method = m; setJsonBody(r, {}); }, [T.statusIn.code('401,403,404,405'), noLeak], 'security')));
      }
      // авторизация через query вместо заголовка не должна приниматься (секреты в URL оседают в логах)
      out.push(cloneItem(item, base + ' — токен в query вместо заголовка', (r) => {
        r.auth = { type: 'noauth' };
        r.header = (r.header || []).filter((h) => !/^authorization$/i.test(h.key));
        r.url = raw + (raw.indexOf('?') === -1 ? '?' : '&') + 'access_token={{token}}';
      }, ['// Сервер не должен принимать токен из URL: он попадает в логи прокси и историю браузера.', T.statusIn.code('400,401,403'), noLeak], 'security'));
      out.push(cloneItem(item, base + ' — заголовки подмены (X-Forwarded-For, X-Original-URL)', (r) => {
        r.header = (r.header || []).concat([{ key: 'X-Forwarded-For', value: '127.0.0.1' }, { key: 'X-Original-URL', value: '/admin' }, { key: 'X-HTTP-Method-Override', value: 'DELETE' }]);
      }, [T.not5xx.code(), noLeak, 'pm.test("Заголовки подмены не меняют поведение", function () {\n    pm.expect(pm.response.code).to.not.equal(204);\n});'], 'security'));
    }
    return out;
  }

  /* ---------- OpenAPI → коллекция ---------- */
  function collectionFromOpenApi(spec) {
    const c = ATA.newCollection((spec.info && spec.info.title) || 'API из OpenAPI');
    const server = spec.servers && spec.servers[0] ? spec.servers[0].url.replace(/\{([^}]+)\}/g, (_, n) => (spec.servers[0].variables && spec.servers[0].variables[n] ? spec.servers[0].variables[n].default : n)) : spec.host ? (spec.schemes ? spec.schemes[0] : 'https') + '://' + spec.host + (spec.basePath || '') : 'https://api.example.com';
    c.variable.push({ key: 'baseUrl', value: server.replace(/\/$/, '') });
    const folders = {};
    ATA.listOperations(spec).sort((a, b) => a.path.localeCompare(b.path)).forEach((o) => {
      const tag = (o.op.tags && o.op.tags[0]) || o.path.split('/').filter(Boolean)[0] || 'root';
      if (!folders[tag]) { folders[tag] = { _id: ATA.uid(), name: tag, item: [] }; c.item.push(folders[tag]); }
      const params = (o.op.parameters || []).concat(o.pathItem.parameters || []).map((p) => (p.$ref ? safeRef(p.$ref, spec) : p)).filter(Boolean);
      let path = o.path.replace(/\{([^}]+)\}/g, (_, n) => {
        const p = params.find((x) => x.name === n && x.in === 'path');
        const ex = p && (p.example !== undefined ? p.example : p.schema ? ATA.sampleFromSchema(p.schema, spec) : undefined);
        if (!c.variable.some((v) => v.key === n)) c.variable.push({ key: n, value: ex !== undefined && ex !== null ? String(ex) : '1' });
        return '{{' + n + '}}';
      });
      const query = params.filter((p) => p.in === 'query' && p.required).map((p) => p.name + '=' + encodeURIComponent(String(p.example !== undefined ? p.example : p.schema ? ATA.sampleFromSchema(p.schema, spec) : 'value')));
      if (query.length) path += '?' + query.join('&');
      const it = ATA.newRequest(o.op.summary || o.op.operationId || o.method + ' ' + o.path, o.method, '{{baseUrl}}' + path);
      it.request.header = params.filter((p) => p.in === 'header').map((p) => ({ key: p.name, value: String(p.example || (p.schema && ATA.sampleFromSchema(p.schema, spec)) || '') }));
      const rb = ATA.requestBodySchema(spec, o);
      if (rb) setJsonBody(it.request, rb.example !== undefined ? rb.example : ATA.sampleFromSchema(rb.schema, spec));
      const codes = Object.keys(o.op.responses || {}).filter((k) => /^2/.test(k));
      const tests = [codes.length ? (codes.length === 1 ? T.status.code(codes[0]) : T.statusIn.code(codes.join(','))) : T.not5xx.code(), T.time.code('2000')];
      const rs = codes.length ? ATA.responseSchema(spec, o, Number(codes[0])) : null;
      if (rs && rs.schema) tests.push('// схема ответа проверяется на вкладке «Контракт» (включите «Проверять контракт при запуске»)');
      ATA.setScript(it, 'test', tests.join('\n\n'));
      folders[tag].item.push(it);
    });
    return c;
  }
  function safeRef(ref, spec) { try { return ATA.resolveRef(ref, spec); } catch (e) { return null; } }

  /* ---------- моки ---------- */
  function newMock(over) {
    return Object.assign({ id: ATA.uid(), enabled: true, name: '', method: 'GET', path: '/example/:id', status: 200, headers: '{}', body: '{\n  "id": "{{path.id}}"\n}', delay: 0, network: '' }, over || {});
  }

  function mockFromResult(r) {
    let path = '/';
    try { path = new URL(r.request.url).pathname; } catch (e) { /* пусто */ }
    const resp = r.response;
    const headers = {};
    (resp.headers || []).forEach(([k, v]) => { if (/^content-type$|^x-total|^location$/i.test(k)) headers[k] = v; });
    return newMock({ name: 'Из ответа: ' + r.name, method: r.request.method, path, status: resp.code, headers: JSON.stringify(headers, null, 2), body: resp.json !== undefined ? JSON.stringify(resp.json, null, 2) : resp.text || '' });
  }

  function mocksFromOpenApi(spec) {
    return ATA.listOperations(spec).map((o) => {
      const code = Object.keys(o.op.responses || {}).find((k) => /^2/.test(k)) || '200';
      const rs = ATA.responseSchema(spec, o, Number(code));
      const body = rs.example !== undefined ? rs.example : rs.schema ? ATA.sampleFromSchema(rs.schema, spec) : null;
      return newMock({ name: o.op.summary || o.op.operationId || o.key, method: o.method, path: o.path.replace(/\{([^}]+)\}/g, ':$1'), status: Number(code) || 200, headers: '{"Content-Type": "application/json"}', body: body == null ? '' : JSON.stringify(body, null, 2) });
    });
  }

  const FAILURE_PRESETS = {
    e500: { label: '500 ошибка', status: 500, body: '{"error": "Internal Server Error"}' },
    e503: { label: '503 + задержка 3 с', status: 503, delay: 3000, body: '{"error": "Service Unavailable"}', headers: '{"Retry-After": "30"}' },
    e429: { label: '429 rate limit', status: 429, body: '{"error": "Too Many Requests"}', headers: '{"Retry-After": "5"}' },
    slow: { label: 'Медленный ответ 5 с', status: 200, delay: 5000 },
    timeout: { label: 'Таймаут (60 с)', status: 200, delay: 60000 },
    broken: { label: 'Битый JSON', status: 200, body: '{"id": 1, "name": ', headers: '{"Content-Type": "application/json"}' },
    empty: { label: 'Пустой ответ 200', status: 200, body: '' },
    network: { label: 'Сетевая ошибка', network: 'error' },
  };

  /** Коллекция с сохранёнными примерами для Postman Mock Server. */
  function collectionWithExamples(mocks, name) {
    const c = ATA.newCollection(name || 'Моки');
    c.variable.push({ key: 'baseUrl', value: 'https://YOUR-MOCK-ID.mock.pstmn.io' });
    mocks.filter((m) => m.enabled && !m.network).forEach((m) => {
      const path = m.path.replace(/:(\w+)/g, '{{$1}}').replace(/\*/g, 'any');
      const it = ATA.newRequest(m.name || m.method + ' ' + m.path, m.method === 'ANY' ? 'GET' : m.method, /^https?:/.test(path) ? path : '{{baseUrl}}' + path);
      let headers = [];
      try { headers = Object.entries(JSON.parse(m.headers || '{}')).map(([key, value]) => ({ key, value: String(value) })); } catch (e) { headers = []; }
      it.response = [{ name: m.name || 'Пример ' + m.status, originalRequest: ATA.clone(it.request), status: ATA.STATUS_TEXT[m.status] || '', code: Number(m.status), _postman_previewlanguage: 'json', header: headers, body: m.body }];
      c.item.push(it);
    });
    return c;
  }

  /* ---------- отчёт ---------- */
  function runReport(results, envName) {
    const total = results.length, passed = results.filter((r) => r.pass).length;
    const lines = ['# Отчёт о прогоне API-тестов', '', '- Дата: ' + new Date().toLocaleString(), '- Окружение: ' + (envName || '—'), '- Запросов: ' + total + ', успешно: ' + passed + ', упало: ' + (total - passed), ''];
    lines.push('| # | Запрос | Статус | Время | Проверки | Итог |', '|---|---|---|---|---|---|');
    results.forEach((r, i) => {
      const t = r.tests || [];
      lines.push('| ' + (i + 1) + ' | ' + (r.request ? r.request.method + ' ' : '') + r.name.replace(/\|/g, '\\|') + ' | ' + (r.response ? r.response.code : r.error ? r.error.kind : '—') + ' | ' + (r.response ? r.response.timeMs + ' мс' : '—') + ' | ' + t.filter((x) => x.pass).length + '/' + t.length + ' | ' + (r.pass ? '✅' : '❌') + ' |');
    });
    const failed = results.filter((r) => !r.pass);
    if (failed.length) {
      lines.push('', '## Падения');
      failed.forEach((r) => {
        const a = analyze(r);
        lines.push('', '### ' + r.name);
        a.findings.forEach((f) => lines.push('- **' + f.title + '** — ' + (f.why || '').replace(/\n/g, '; ')));
      });
    }
    return lines.join('\n');
  }

  Object.assign(ATA, { analyzeVarFlow, diffJson, snapshotCode, summarizeRun, compareRuns, runKey, junitXml, htmlReport, ASSERTION_TYPES, inferSchema, analyze, bugReport, maskReq, CASE_GROUPS, generateCases, collectionFromOpenApi, newMock, mockFromResult, mocksFromOpenApi, FAILURE_PRESETS, collectionWithExamples, runReport, jsonBodyOf, setJsonBody });
})(typeof window !== 'undefined' ? window : globalThis);
