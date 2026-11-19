/* Экспорт коллекции в код автотестов: Playwright (TypeScript), pytest (Python), k6 (нагрузка). */
(function (G) {
  'use strict';
  const ATA = (G.ATA = G.ATA || {});

  /* ---------- разбор Tests-скрипта в промежуточное описание ---------- */

  /** Найти блоки pm.test(...) со скобочным разбором (учитывая строки). → [{name, body, start, end}] */
  function findTestBlocks(code) {
    const out = [];
    const re = /pm\.test\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(?:function\s*\(\s*\)|\(\s*\)\s*=>)\s*\{/g;
    let m;
    while ((m = re.exec(code))) {
      let i = re.lastIndex, depth = 1, q = null;
      for (; i < code.length && depth; i++) {
        const ch = code[i];
        if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') q = ch;
        else if (ch === '/' && code[i + 1] === '/') { const nl = code.indexOf('\n', i); i = nl < 0 ? code.length : nl; }
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth) break;
      const tail = /^\s*\)\s*;?/.exec(code.slice(i));
      const end = i + (tail ? tail[0].length : 0);
      out.push({ name: m[2], body: code.slice(re.lastIndex, i - 1), start: m.index, end });
      re.lastIndex = end;
    }
    return out;
  }

  /** «.a.b[0]["c d"]» → ['a','b',0,'c d'] или null. */
  function parseAccessor(s) {
    const keys = [];
    const re = /\.([A-Za-z_$][\w$]*)|\[\s*(\d+)\s*\]|\[\s*(['"])((?:\\.|(?!\3).)*)\3\s*\]/y;
    let pos = 0;
    while (pos < s.length) {
      re.lastIndex = pos;
      const m = re.exec(s);
      if (!m) return null;
      keys.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? Number(m[2]) : m[4]);
      pos = re.lastIndex;
    }
    return keys;
  }
  const dotPath = (p) => String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).map((k) => (/^\d+$/.test(k) ? Number(k) : k));

  /** Литерал значения → JS-значение, или undefined, если это не литерал. */
  function literal(src) {
    const s = src.trim();
    const sq = /^'((?:\\.|[^'\\])*)'$/.exec(s);
    try {
      if (sq) return JSON.parse('"' + sq[1].replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
      return JSON.parse(s);
    } catch (e) { return undefined; }
  }

  /**
   * Tests-скрипт → {checks:[...], saves:[...], todo:[...]}
   * check: {kind:'status'|'statusIn'|'statusBelow'|'status2xx'|'time'|'header'|'jsonEq'|'jsonHas'|'text'|'json', ...}
   */
  function translateTests(code) {
    const ir = { checks: [], saves: [], todo: [] };
    code = String(code || '');
    if (!code.trim()) return ir;
    const aliases = new Set();
    const aliasRe = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*pm\.response\.json\(\)\s*;?/g;
    let am;
    while ((am = aliasRe.exec(code))) aliases.add(am[1]);
    const J = '(?:pm\\.response\\.json\\(\\)' + Array.from(aliases).map((a) => '|' + a.replace(/\$/g, '\\$')).join('') + ')';
    const acc = '((?:\\.[A-Za-z_$][\\w$]*|\\[\\s*\\d+\\s*\\]|\\[\\s*["\'][^"\']*["\']\\s*\\])*)';
    const PATTERNS = [
      [/^pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)$/, (m) => ({ kind: 'status', code: Number(m[1]) })],
      [/^pm\.response\.to\.be\.(ok|success)$/, () => ({ kind: 'status2xx' })],
      [/^pm\.response\.to\.be\.json$/, () => ({ kind: 'json' })],
      [/^pm\.expect\(\s*pm\.response\.code\s*\)\.to\.(?:be\.)?(?:eql|equal|eq)\(\s*(\d{3})\s*\)$/, (m) => ({ kind: 'status', code: Number(m[1]) })],
      [/^pm\.expect\(\s*pm\.response\.code\s*\)\.to\.be\.oneOf\(\s*\[([\d\s,]+)\]\s*\)$/, (m) => ({ kind: 'statusIn', codes: m[1].split(',').map((x) => Number(x.trim())).filter(Boolean) })],
      [/^pm\.expect\(\s*pm\.response\.code\s*\)\.to\.be\.below\(\s*(\d+)\s*\)$/, (m) => ({ kind: 'statusBelow', code: Number(m[1]) })],
      [/^pm\.expect\(\s*pm\.response\.responseTime\s*\)\.to\.be\.below\(\s*(\d+)\s*\)$/, (m) => ({ kind: 'time', ms: Number(m[1]) })],
      [/^pm\.response\.to\.have\.header\(\s*(['"])([^'"]+)\1\s*\)$/, (m) => ({ kind: 'header', name: m[2] })],
      [/^pm\.expect\(\s*pm\.response\.text\(\)\s*\)\.to\.include\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)$/, (m) => ({ kind: 'text', value: literal(m[1] + m[2] + m[1]) })],
      [/^pm\.response\.to\.have\.jsonBody\(\s*(['"])([^'"]+)\1\s*,\s*([\s\S]+)\)$/, (m) => { const v = literal(m[3]); return v === undefined ? null : { kind: 'jsonEq', path: dotPath(m[2]), value: v }; }],
      [/^pm\.response\.to\.have\.jsonBody\(\s*(['"])([^'"]+)\1\s*\)$/, (m) => ({ kind: 'jsonHas', path: dotPath(m[2]) })],
      [new RegExp('^pm\\.expect\\(\\s*' + J + acc + '\\s*\\)\\.to\\.(?:deep\\.)?(?:eql|equal|eq)\\(([\\s\\S]+)\\)$'), (m) => { const p = parseAccessor(m[1]); const v = literal(m[2]); return p && v !== undefined ? { kind: 'jsonEq', path: p, value: v } : null; }],
      [new RegExp('^pm\\.expect\\(\\s*' + J + acc + '\\s*\\)\\.to\\.have\\.property\\(\\s*([\'"])([^\'"]+)\\2\\s*\\)$'), (m) => { const p = parseAccessor(m[1]); return p ? { kind: 'jsonHas', path: p.concat([m[3]]) } : null; }],
      [new RegExp('^pm\\.expect\\(\\s*' + J + acc + '\\s*\\)\\.to\\.be\\.an?\\(\\s*([\'"])(array|object|string|number|boolean)\\2\\s*\\)$'), (m) => { const p = parseAccessor(m[1]); return p ? { kind: 'type', path: p, type: m[3] } : null; }],
      [new RegExp('^pm\\.expect\\(\\s*' + J + acc + '\\s*\\)\\.to\\.have\\.(?:lengthOf|length)\\(\\s*(\\d+)\\s*\\)$'), (m) => { const p = parseAccessor(m[1]); return p ? { kind: 'length', path: p, n: Number(m[2]) } : null; }],
      [/^(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*pm\.response\.json\(\)$/, () => ({ kind: 'noop' })],
    ];
    const one = (stmt) => {
      const s = stmt.trim().replace(/;$/, '').trim();
      for (const [re, mk] of PATTERNS) { const m = re.exec(s); if (m) return mk(m); }
      return null;
    };
    const stmts = (body) => body.split(/;\s*\n|\n|;(?=\s*pm\.)/).map((x) => x.trim()).filter((x) => x && !/^\/\//.test(x));

    const blocks = findTestBlocks(code);
    let rest = '';
    let last = 0;
    blocks.forEach((b) => {
      rest += code.slice(last, b.start);
      last = b.end;
      const parts = stmts(b.body);
      const translated = parts.map(one);
      if (parts.length && translated.every(Boolean) && translated.some((c) => c.kind !== 'noop')) translated.filter((c) => c.kind !== 'noop').forEach((c) => ir.checks.push(Object.assign({ test: b.name }, c)));
      else ir.todo.push(code.slice(b.start, b.end).trim());
    });
    rest += code.slice(last);
    // вне pm.test: сохранение переменных и объявления алиасов
    const saveRe = new RegExp('^pm\\.(?:environment|collectionVariables|variables|globals)\\.set\\(\\s*([\'"])([^\'"]+)\\1\\s*,\\s*' + J + acc + '\\s*\\)$');
    stmts(rest).forEach((s) => {
      const t = s.replace(/;$/, '').trim();
      if (/^(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*pm\.response\.json\(\)$/.test(t)) return;
      const m = saveRe.exec(t);
      const p = m && parseAccessor(m[3]);
      if (p) ir.saves.push({ name: m[2], path: p });
      else if (!/^console\.log\(/.test(t)) ir.todo.push(s);
    });
    return ir;
  }

  /* ---------- шаблон запроса (без подстановки переменных) ---------- */
  function templateRequest(c, item, parents) {
    const r = item.request;
    let url = ATA.urlRaw(r.url).trim();
    const headers = (r.header || []).filter((x) => !x.disabled && x.key).map((x) => [x.key, String(x.value == null ? '' : x.value)]);
    const has = (n) => headers.some(([k]) => k.toLowerCase() === n.toLowerCase());
    let body = null;
    const b = r.body || {};
    if (b.mode === 'raw' && b.raw) {
      body = b.raw;
      const lang = b.options && b.options.raw && b.options.raw.language;
      if (!has('Content-Type') && (lang === 'json' || (!lang && /^\s*[[{]/.test(body)))) headers.push(['Content-Type', 'application/json']);
    } else if (b.mode === 'urlencoded') {
      body = (b.urlencoded || []).filter((p) => !p.disabled).map((p) => p.key + '=' + (p.value || '')).join('&');
      if (!has('Content-Type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    }
    let basic = null;
    const auth = ATA.effectiveAuth(c, item, parents);
    const ap = (k) => { const list = auth && auth[auth.type]; const p = Array.isArray(list) ? list.find((x) => x.key === k) : null; return p ? String(p.value == null ? '' : p.value) : ''; };
    if (auth && auth.type === 'bearer' && !has('Authorization')) headers.push(['Authorization', 'Bearer ' + ap('token')]);
    if (auth && auth.type === 'basic' && !has('Authorization')) basic = { user: ap('username'), pass: ap('password') };
    if (auth && auth.type === 'apikey') {
      if (ap('in') === 'query') url += (url.indexOf('?') === -1 ? '?' : '&') + (ap('key') || 'api_key') + '=' + ap('value');
      else headers.push([ap('key') || 'X-API-Key', ap('value')]);
    }
    return { method: r.method || 'GET', url, headers, body, basic };
  }

  /* ---------- общие помощники генераторов ---------- */
  const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const slug = (s) => String(s).toLowerCase().split('').map((ch) => (TR[ch] !== undefined ? TR[ch] : ch)).join('').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'request';
  const q = (s) => JSON.stringify(String(s));
  const envName = (k) => k.replace(/[^A-Za-z0-9]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  const isSecret = (v) => v.type === 'secret' || /token|secret|passw|api[-_]?key|private|auth|cookie/i.test(v.key || '');

  /** Переменные для шапки файла: значения не-секретов, секреты — только из окружения ОС. */
  function varsList(c, envValues) {
    const map = new Map();
    (c.variable || []).filter((v) => v.key && !v.disabled).forEach((v) => map.set(v.key, v));
    (envValues || []).filter((v) => v.key && v.enabled !== false).forEach((v) => map.set(v.key, v));
    return Array.from(map.values()).map((v) => ({ key: v.key, env: envName(v.key), value: isSecret(v) ? '' : String(v.value == null ? '' : v.value), secret: isSecret(v) }));
  }

  function collect(c, targets, envValues) {
    return targets.map((t, i) => {
      const tests = [c].concat(t.parents, [t.item]).map((n) => ATA.scriptOf(n, 'test')).filter(Boolean).join('\n\n');
      const pre = [c].concat(t.parents, [t.item]).map((n) => ATA.scriptOf(n, 'prerequest')).filter(Boolean).join('\n\n');
      return { index: i + 1, item: t.item, folder: t.parents.map((p) => p.name).join(' / '), req: templateRequest(c, t.item, t.parents), ir: translateTests(tests), pre };
    });
  }
  const todoLines = (ir, pre, comment) => {
    const out = [];
    if (pre && pre.trim()) out.push(comment + ' TODO: pre-request скрипт Postman — перенесите вручную:', ...pre.split('\n').map((l) => comment + '   ' + l));
    ir.todo.forEach((t) => out.push(comment + ' TODO: не переведено автоматически:', ...t.split('\n').map((l) => comment + '   ' + l)));
    return out;
  };

  const JSON_KINDS = new Set(['jsonEq', 'jsonHas', 'type', 'length']);

  /* ---------- Playwright (TypeScript) ---------- */
  function jsAcc(path) { return path.map((k) => (typeof k === 'number' ? '[' + k + ']' : /^[A-Za-z_$][\w$]*$/.test(k) ? '?.' + k : '?.[' + q(k) + ']')).join(''); }
  function toPlaywright(c, targets, opts) {
    opts = opts || {};
    const reqs = collect(c, targets, opts.envValues);
    const vars = varsList(c, opts.envValues);
    const L = [
      "import { test, expect } from '@playwright/test';",
      '',
      '// Сгенерировано «Помощником API-тестирования» из коллекции ' + q(c.info.name) + '.',
      '// Запуск: npm i -D @playwright/test && npx playwright test',
      '// Секреты передавайте через переменные окружения: ' + (vars.filter((v) => v.secret).map((v) => v.env).join(', ') || '—'),
      '',
      'const vars: Record<string, string> = {',
      ...vars.map((v) => '  ' + q(v.key) + ': process.env.' + v.env + " ?? " + q(v.value) + ',' + (v.secret ? ' // секрет' : '')),
      '};',
      '',
      'const dynamic: Record<string, () => string> = {',
      "  $guid: () => crypto.randomUUID(),",
      "  $randomUUID: () => crypto.randomUUID(),",
      "  $timestamp: () => String(Math.floor(Date.now() / 1000)),",
      "  $isoTimestamp: () => new Date().toISOString(),",
      "  $randomInt: () => String(Math.floor(Math.random() * 1001)),",
      '};',
      "const v = (s: string): string => s.replace(/\\{\\{\\s*([^{}]+?)\\s*\\}\\}/g, (_, n: string) => (dynamic[n] ? dynamic[n]() : vars[n] ?? ''));",
      '',
      '// запросы выполняются по порядку: значения, сохранённые одним тестом, нужны следующим',
      'test.describe.serial(' + q(c.info.name) + ', () => {',
    ];
    reqs.forEach((r) => {
      const { req, ir } = r;
      const needJson = ir.checks.some((x) => JSON_KINDS.has(x.kind)) || ir.saves.length;
      L.push('  test(' + q(r.index + '. ' + req.method + ' ' + r.item.name) + ', async ({ request }) => {');
      const hdrs = req.headers.map(([k, val]) => q(k) + ': v(' + q(val) + ')');
      if (req.basic) hdrs.push("'Authorization': 'Basic ' + Buffer.from(v(" + q(req.basic.user + ':' + req.basic.pass) + ")).toString('base64')");
      L.push('    const started = Date.now();');
      L.push('    const res = await request.fetch(v(' + q(req.url) + '), {');
      L.push('      method: ' + q(req.method) + ',');
      if (hdrs.length) L.push('      headers: { ' + hdrs.join(', ') + ' },');
      if (req.body != null) L.push('      data: v(' + q(req.body) + '),');
      L.push('    });');
      if (ir.checks.some((x) => x.kind === 'time')) L.push('    const elapsed = Date.now() - started;');
      if (needJson || ir.checks.some((x) => x.kind === 'json')) L.push('    const json = await res.json();');
      if (ir.checks.some((x) => x.kind === 'text')) L.push('    const text = await res.text();');
      if (!ir.checks.some((x) => /^status/.test(x.kind))) L.push('    expect(res.status(), ' + q('нет ошибки сервера') + ').toBeLessThan(500);');
      ir.checks.forEach((x) => {
        const msg = q(x.test);
        if (x.kind === 'status') L.push('    expect(res.status(), ' + msg + ').toBe(' + x.code + ');');
        if (x.kind === 'status2xx') L.push('    expect(res.ok(), ' + msg + ').toBeTruthy();');
        if (x.kind === 'statusIn') L.push('    expect(' + JSON.stringify(x.codes) + ', ' + msg + ').toContain(res.status());');
        if (x.kind === 'statusBelow') L.push('    expect(res.status(), ' + msg + ').toBeLessThan(' + x.code + ');');
        if (x.kind === 'time') L.push('    expect(elapsed, ' + msg + ').toBeLessThan(' + x.ms + ');');
        if (x.kind === 'header') L.push('    expect(res.headers()[' + q(x.name.toLowerCase()) + '], ' + msg + ').toBeDefined();');
        if (x.kind === 'json') L.push('    expect(json, ' + msg + ').toBeDefined();');
        if (x.kind === 'text') L.push('    expect(text, ' + msg + ').toContain(' + q(x.value) + ');');
        if (x.kind === 'jsonEq') L.push('    expect(json' + jsAcc(x.path) + ', ' + msg + ').toEqual(' + JSON.stringify(x.value) + ');');
        if (x.kind === 'jsonHas') L.push('    expect(json' + jsAcc(x.path) + ', ' + msg + ').toBeDefined();');
        if (x.kind === 'type') L.push('    expect(' + (x.type === 'array' ? 'Array.isArray(json' + jsAcc(x.path) + ')' : 'typeof json' + jsAcc(x.path)) + ', ' + msg + ').toBe(' + (x.type === 'array' ? 'true' : q(x.type)) + ');');
        if (x.kind === 'length') L.push('    expect(json' + jsAcc(x.path) + ', ' + msg + ').toHaveLength(' + x.n + ');');
      });
      ir.saves.forEach((s) => L.push('    vars[' + q(s.name) + '] = String(json' + jsAcc(s.path) + ');'));
      todoLines(ir, r.pre, '    //').forEach((l) => L.push(l));
      L.push('  });', '');
    });
    L.push('});', '');
    return L.join('\n');
  }

  /* ---------- pytest ---------- */
  const pyLit = (v) => (v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : typeof v === 'number' ? String(v) : typeof v === 'string' ? JSON.stringify(v) : 'json.loads(' + JSON.stringify(JSON.stringify(v)) + ')');
  const pyAcc = (path) => path.map((k) => '[' + (typeof k === 'number' ? k : JSON.stringify(k)) + ']').join('');
  function toPytest(c, targets, opts) {
    opts = opts || {};
    const reqs = collect(c, targets, opts.envValues);
    const vars = varsList(c, opts.envValues);
    const L = [
      '"""Сгенерировано «Помощником API-тестирования» из коллекции ' + JSON.stringify(c.info.name) + '.',
      '',
      'Запуск: pip install requests pytest && pytest -v ' + (opts.fileName || 'test_api.py'),
      'Секреты передавайте через переменные окружения: ' + (vars.filter((v) => v.secret).map((v) => v.env).join(', ') || '—'),
      'Тесты выполняются по порядку файла: значения, сохранённые одним тестом, нужны следующим.',
      '"""',
      'import base64',
      'import json',
      'import os',
      'import random',
      'import re',
      'import time',
      'import uuid',
      '',
      'import requests',
      '',
      'VARS = {',
      ...vars.map((v) => '    ' + JSON.stringify(v.key) + ': os.environ.get(' + JSON.stringify(v.env) + ', ' + JSON.stringify(v.value) + '),' + (v.secret ? '  # секрет' : '')),
      '}',
      'TIMEOUT = 30',
      '',
      '',
      'def v(s):',
      '    """Подставляет {{переменные}} и динамические переменные Postman."""',
      '    def repl(m):',
      '        name = m.group(1).strip()',
      '        if name in ("$guid", "$randomUUID"):',
      '            return str(uuid.uuid4())',
      '        if name == "$timestamp":',
      '            return str(int(time.time()))',
      '        if name == "$isoTimestamp":',
      '            return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())',
      '        if name == "$randomInt":',
      '            return str(random.randint(0, 1000))',
      '        return str(VARS.get(name, ""))',
      '    return re.sub(r"\\{\\{\\s*([^{}]+?)\\s*\\}\\}", repl, s)',
      '',
    ];
    reqs.forEach((r) => {
      const { req, ir } = r;
      L.push('', 'def test_' + String(r.index).padStart(3, '0') + '_' + slug(r.item.name) + '():');
      L.push('    """' + (req.method + ' ' + r.item.name + (r.folder ? ' (' + r.folder + ')' : '')).replace(/"""/g, "'''").replace(/\\/g, '\\\\') + '"""');
      const hdrs = req.headers.map(([k, val]) => JSON.stringify(k) + ': v(' + JSON.stringify(val) + ')');
      if (req.basic) hdrs.push('"Authorization": "Basic " + base64.b64encode(v(' + JSON.stringify(req.basic.user + ':' + req.basic.pass) + ').encode()).decode()');
      L.push('    headers = {' + hdrs.join(', ') + '}');
      L.push('    started = time.monotonic()');
      L.push('    r = requests.request(' + JSON.stringify(req.method) + ', v(' + JSON.stringify(req.url) + '), headers=headers' + (req.body != null ? ', data=v(' + JSON.stringify(req.body) + ').encode("utf-8")' : '') + ', timeout=TIMEOUT)');
      if (ir.checks.some((x) => x.kind === 'time')) L.push('    elapsed_ms = (time.monotonic() - started) * 1000');
      if (ir.checks.some((x) => JSON_KINDS.has(x.kind) || x.kind === 'json') || ir.saves.length) L.push('    data = r.json()');
      if (!ir.checks.some((x) => /^status/.test(x.kind))) L.push('    assert r.status_code < 500, "нет ошибки сервера"');
      ir.checks.forEach((x) => {
        const msg = ', ' + JSON.stringify(x.test);
        if (x.kind === 'status') L.push('    assert r.status_code == ' + x.code + msg);
        if (x.kind === 'status2xx') L.push('    assert 200 <= r.status_code < 300' + msg);
        if (x.kind === 'statusIn') L.push('    assert r.status_code in (' + x.codes.join(', ') + (x.codes.length === 1 ? ',' : '') + ')' + msg);
        if (x.kind === 'statusBelow') L.push('    assert r.status_code < ' + x.code + msg);
        if (x.kind === 'time') L.push('    assert elapsed_ms < ' + x.ms + msg);
        if (x.kind === 'header') L.push('    assert ' + JSON.stringify(x.name.toLowerCase()) + ' in {k.lower() for k in r.headers}' + msg);
        if (x.kind === 'json') L.push('    assert data is not None' + msg);
        if (x.kind === 'text') L.push('    assert ' + JSON.stringify(x.value) + ' in r.text' + msg);
        if (x.kind === 'jsonEq') L.push('    assert data' + pyAcc(x.path) + ' == ' + pyLit(x.value) + msg);
        if (x.kind === 'jsonHas') L.push(typeof x.path[x.path.length - 1] === 'number' ? '    assert len(data' + pyAcc(x.path.slice(0, -1)) + ') > ' + x.path[x.path.length - 1] + msg : '    assert data' + pyAcc(x.path.slice(0, -1)) + '.get(' + JSON.stringify(x.path[x.path.length - 1]) + ') is not None' + msg);
        if (x.kind === 'type') L.push('    assert isinstance(data' + pyAcc(x.path) + ', ' + { array: 'list', object: 'dict', string: 'str', number: '(int, float)', boolean: 'bool' }[x.type] + ')' + msg);
        if (x.kind === 'length') L.push('    assert len(data' + pyAcc(x.path) + ') == ' + x.n + msg);
      });
      ir.saves.forEach((s) => L.push('    VARS[' + JSON.stringify(s.name) + '] = str(data' + pyAcc(s.path) + ')'));
      todoLines(ir, r.pre, '    #').forEach((l) => L.push(l));
    });
    L.push('');
    return L.join('\n');
  }

  /* ---------- k6 ---------- */
  function toK6(c, targets, opts) {
    opts = opts || {};
    const reqs = collect(c, targets, opts.envValues);
    const vars = varsList(c, opts.envValues);
    const vus = Math.max(1, opts.vus || 5), iterations = Math.max(1, opts.iterations || 100), p95 = opts.p95 || 2000;
    const L = [
      "import http from 'k6/http';",
      "import { check, sleep } from 'k6';",
      "import encoding from 'k6/encoding';",
      '',
      '// Сгенерировано «Помощником API-тестирования» из коллекции ' + q(c.info.name) + '.',
      '// Запуск: k6 run ' + (opts.fileName || 'load.js') + (vars.some((v) => v.secret) ? ' -e ' + vars.filter((v) => v.secret).map((v) => v.env + '=…').join(' -e ') : ''),
      '// Запускайте только на своих тестовых стендах.',
      '',
      'export const options = {',
      '  scenarios: {',
      "    main: { executor: 'shared-iterations', vus: " + vus + ', iterations: ' + iterations + ", maxDuration: '10m' },",
      '  },',
      '  thresholds: {',
      "    http_req_failed: ['rate<0.01'],",
      "    http_req_duration: ['p(95)<" + p95 + "'],",
      "    checks: ['rate>0.99'],",
      '  },',
      '};',
      '',
      'const vars = {',
      ...vars.map((v) => '  ' + q(v.key) + ': __ENV.' + v.env + ' || ' + q(v.value) + ',' + (v.secret ? ' // секрет: -e ' + v.env + '=…' : '')),
      '};',
      "const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16); });",
      'const dynamic = { $guid: uuid, $randomUUID: uuid, $timestamp: () => String(Math.floor(Date.now() / 1000)), $isoTimestamp: () => new Date().toISOString(), $randomInt: () => String(Math.floor(Math.random() * 1001)) };',
      "const v = (s) => s.replace(/\\{\\{\\s*([^{}]+?)\\s*\\}\\}/g, (_, n) => (dynamic[n] ? dynamic[n]() : vars[n] ?? ''));",
      "const body = (r) => { try { return r.json(); } catch (e) { return undefined; } };",
      '',
      'export default function () {',
    ];
    reqs.forEach((r) => {
      const { req, ir } = r;
      const hdrs = req.headers.map(([k, val]) => q(k) + ': v(' + q(val) + ')');
      if (req.basic) hdrs.push("'Authorization': 'Basic ' + encoding.b64encode(v(" + q(req.basic.user + ':' + req.basic.pass) + '))');
      const name = 'r' + r.index;
      L.push('  // ' + r.index + '. ' + req.method + ' ' + r.item.name);
      L.push('  const ' + name + ' = http.request(' + q(req.method) + ', v(' + q(req.url) + '), ' + (req.body != null ? 'v(' + q(req.body) + ')' : 'null') + ', { headers: { ' + hdrs.join(', ') + ' }, tags: { name: ' + q(r.item.name) + ' } });');
      const checks = [];
      if (!ir.checks.some((x) => /^status/.test(x.kind))) checks.push(q('нет 5xx') + ': (res) => res.status < 500');
      ir.checks.forEach((x) => {
        const label = q(x.test + (x.kind === 'jsonEq' || x.kind === 'jsonHas' ? ' (' + x.path.join('.') + ')' : ''));
        if (x.kind === 'status') checks.push(label + ': (res) => res.status === ' + x.code);
        if (x.kind === 'status2xx') checks.push(label + ': (res) => res.status >= 200 && res.status < 300');
        if (x.kind === 'statusIn') checks.push(label + ': (res) => ' + JSON.stringify(x.codes) + '.includes(res.status)');
        if (x.kind === 'statusBelow') checks.push(label + ': (res) => res.status < ' + x.code);
        if (x.kind === 'time') checks.push(label + ': (res) => res.timings.duration < ' + x.ms);
        if (x.kind === 'header') checks.push(label + ': (res) => res.headers[' + q(x.name.replace(/(^|-)([a-z])/g, (m0, a, b) => a + b.toUpperCase())) + '] !== undefined');
        if (x.kind === 'json') checks.push(label + ': (res) => body(res) !== undefined');
        if (x.kind === 'text') checks.push(label + ': (res) => String(res.body).includes(' + q(x.value) + ')');
        if (x.kind === 'jsonEq') checks.push(label + ': (res) => JSON.stringify(body(res)' + jsAcc(x.path) + ') === ' + q(JSON.stringify(x.value)));
        if (x.kind === 'jsonHas') checks.push(label + ': (res) => body(res)' + jsAcc(x.path) + ' !== undefined');
        if (x.kind === 'type') checks.push(label + ': (res) => ' + (x.type === 'array' ? 'Array.isArray(body(res)' + jsAcc(x.path) + ')' : 'typeof body(res)' + jsAcc(x.path) + ' === ' + q(x.type)));
        if (x.kind === 'length') checks.push(label + ': (res) => (body(res)' + jsAcc(x.path) + ' || []).length === ' + x.n);
      });
      L.push('  check(' + name + ', {', ...checks.map((x) => '    ' + x + ','), '  });');
      ir.saves.forEach((s) => L.push('  vars[' + q(s.name) + '] = String(body(' + name + ')' + jsAcc(s.path) + ');'));
      todoLines(ir, r.pre, '  //').forEach((l) => L.push(l));
    });
    L.push('  sleep(' + (opts.thinkTime != null ? opts.thinkTime : 1) + ');', '}', '');
    return L.join('\n');
  }

  const FORMATS = {
    playwright: { label: 'Playwright Test (TypeScript)', file: 'api.spec.ts', type: 'text/plain', fn: toPlaywright },
    pytest: { label: 'pytest + requests (Python)', file: 'test_api.py', type: 'text/x-python', fn: toPytest },
    k6: { label: 'k6 (нагрузочный сценарий)', file: 'load.js', type: 'text/javascript', fn: toK6 },
  };

  /** Статистика перевода: сколько проверок переведено, сколько TODO. */
  function exportStats(c, targets) {
    let checks = 0, todo = 0, pre = 0;
    collect(c, targets, []).forEach((r) => { checks += r.ir.checks.length; todo += r.ir.todo.length; if (r.pre.trim()) pre++; });
    return { requests: targets.length, checks, todo, pre };
  }

  Object.assign(ATA, { translateTests, findTestBlocks, parseAccessor, templateRequest, toPlaywright, toPytest, toK6, EXPORT_FORMATS: FORMATS, exportStats });
})(typeof window !== 'undefined' ? window : globalThis);
