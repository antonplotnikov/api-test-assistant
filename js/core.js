/* Модель Postman-коллекции, переменные, отправка запросов, моки, раннер, cURL, CSV, статистика. */
(function (G) {
  'use strict';
  const ATA = (G.ATA = G.ATA || {});

  /* ---------- utils ---------- */
  let seq = 0;
  const uid = () => 'i' + Date.now().toString(36) + (seq++).toString(36);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const uuid = () => (G.crypto && G.crypto.randomUUID ? G.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

  /* ---------- переменные ---------- */
  const DYNAMIC = {
    $guid: uuid, $randomUUID: uuid,
    $timestamp: () => String(Math.floor(Date.now() / 1000)),
    $isoTimestamp: () => new Date().toISOString(),
    $randomInt: () => String(Math.floor(Math.random() * 1001)),
    $randomEmail: () => 'qa' + Math.floor(Math.random() * 1e6) + '@example.com',
    $randomFirstName: () => ['Анна', 'Иван', 'Мария', 'Пётр', 'Alex', 'Kate'][Math.floor(Math.random() * 6)],
    $randomAlphaNumeric: () => Math.random().toString(36).slice(2, 3),
    $randomBoolean: () => String(Math.random() < 0.5),
    $randomPhoneNumber: () => '+7' + String(Math.floor(9e9 + Math.random() * 1e9)),
  };
  // остальные популярные динамические переменные Postman
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const FIRST = ['Anna', 'Ivan', 'Maria', 'Peter', 'Alex', 'Kate', 'Olga', 'Dmitry', 'Elena', 'Sergey'];
  const LAST = ['Ivanov', 'Smirnova', 'Petrov', 'Kuznetsova', 'Sokolov', 'Popova', 'Lebedev', 'Novikova'];
  const CITIES = ['Moscow', 'Saint Petersburg', 'Kazan', 'Novosibirsk', 'Berlin', 'London', 'Paris', 'Tokyo'];
  const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
  const dayMs = 86400000;
  const isoDate = (ms) => new Date(ms).toISOString();
  Object.assign(DYNAMIC, {
    $randomFirstName: () => pick(FIRST),
    $randomLastName: () => pick(LAST),
    $randomFullName: () => pick(FIRST) + ' ' + pick(LAST),
    $randomUserName: () => pick(FIRST).toLowerCase() + '.' + pick(LAST).toLowerCase() + rnd(1, 999),
    $randomPassword: () => Math.random().toString(36).slice(2, 10) + 'A1!' + Math.random().toString(36).slice(2, 6),
    $randomCity: () => pick(CITIES),
    $randomCountry: () => pick(['Russia', 'Germany', 'France', 'Japan', 'Brazil', 'Canada']),
    $randomCountryCode: () => pick(['RU', 'DE', 'FR', 'JP', 'BR', 'CA']),
    $randomStreetAddress: () => rnd(1, 200) + ' ' + pick(['Main', 'Oak', 'Lenina', 'Park', 'River']) + ' St',
    $randomCompanyName: () => pick(['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli']) + ' ' + pick(['LLC', 'Inc', 'Group']),
    $randomJobTitle: () => pick(['QA Engineer', 'Developer', 'Product Manager', 'Designer', 'Analyst']),
    $randomWord: () => pick(WORDS),
    $randomWords: () => Array.from({ length: rnd(2, 5) }, () => pick(WORDS)).join(' '),
    $randomLoremWord: () => pick(WORDS),
    $randomLoremSentence: () => { const s = Array.from({ length: rnd(5, 10) }, () => pick(WORDS)).join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; },
    $randomLoremParagraph: () => Array.from({ length: 3 }, () => DYNAMIC.$randomLoremSentence()).join(' '),
    $randomUrl: () => 'https://' + pick(WORDS) + '.example.com/' + pick(WORDS),
    $randomDomainName: () => pick(WORDS) + '.example.com',
    $randomIP: () => [rnd(1, 223), rnd(0, 255), rnd(0, 255), rnd(1, 254)].join('.'),
    $randomIPV6: () => Array.from({ length: 8 }, () => rnd(0, 65535).toString(16)).join(':'),
    $randomColor: () => pick(['red', 'green', 'blue', 'black', 'white', 'orange']),
    $randomHexColor: () => '#' + rnd(0, 0xffffff).toString(16).padStart(6, '0'),
    $randomPrice: () => (rnd(100, 99999) / 100).toFixed(2),
    $randomCurrencyCode: () => pick(['RUB', 'USD', 'EUR', 'JPY', 'GBP']),
    $randomLocale: () => pick(['ru', 'en', 'de', 'fr', 'ja']),
    $randomUserAgent: () => 'Mozilla/5.0 (API Test Assistant)',
    $randomDatePast: () => isoDate(Date.now() - rnd(1, 365) * dayMs),
    $randomDateFuture: () => isoDate(Date.now() + rnd(1, 365) * dayMs),
    $randomDateRecent: () => isoDate(Date.now() - rnd(0, 2) * dayMs - rnd(0, dayMs)),
    $randomEmail: () => pick(FIRST).toLowerCase() + '.' + rnd(1, 99999) + '@example.com',
    $randomExampleEmail: () => pick(WORDS) + rnd(1, 999) + '@example.com',
    $randomInt: () => String(rnd(0, 1000)),
    $randomAlphaNumeric: () => Math.random().toString(36).slice(2, 3),
    $randomFileName: () => pick(WORDS) + '.' + pick(['txt', 'pdf', 'png', 'json']),
    $randomMimeType: () => pick(['application/json', 'text/plain', 'image/png', 'application/pdf']),
  });

  /** Подстановка {{var}}: scopes — массив Map в порядке приоритета. → {value, unresolved:[]} */
  function resolveString(str, scopes, depth) {
    const unresolved = [];
    if (typeof str !== 'string' || str.indexOf('{{') === -1) return { value: str, unresolved };
    depth = depth || 0;
    const value = str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name) => {
      if (name.startsWith('$') && DYNAMIC[name]) return DYNAMIC[name]();
      for (const s of scopes) {
        if (s && s.has(name)) {
          const v = String(s.get(name));
          if (depth < 5 && v.indexOf('{{') !== -1) { const r = resolveString(v, scopes, depth + 1); unresolved.push(...r.unresolved); return r.value; }
          return v;
        }
      }
      unresolved.push(name);
      return m;
    });
    return { value, unresolved };
  }

  /* ---------- коллекция ---------- */
  const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

  function newCollection(name) {
    return { info: { _postman_id: uuid(), name: name || 'Новая коллекция', schema: SCHEMA_V21 }, item: [], variable: [] };
  }

  function newRequest(name, method, url) {
    return { _id: uid(), name: name || 'Новый запрос', request: { method: method || 'GET', header: [], url: url || '{{baseUrl}}/', body: { mode: 'none' } }, event: [], response: [] };
  }

  /** Проставить внутренние _id всем элементам и привести URL/тело к удобному виду. */
  function normalizeCollection(c) {
    if (!c || !c.info) throw new Error('Это не Postman-коллекция v2.x (нет поля info)');
    if (c.info.schema && /v1\.0\.0/.test(c.info.schema)) throw new Error('Коллекции v1 не поддерживаются — экспортируйте из Postman в формате v2.1');
    c.item = c.item || [];
    c.variable = c.variable || [];
    const visit = (items) => items.forEach((it) => {
      it._id = it._id || uid();
      if (it.item) { visit(it.item); return; }
      if (typeof it.request === 'string') it.request = { method: 'GET', url: it.request, header: [] };
      it.request = it.request || { method: 'GET', url: '', header: [] };
      it.request.method = (it.request.method || 'GET').toUpperCase();
      it.request.header = it.request.header || [];
      it.event = it.event || [];
      it.response = it.response || [];
    });
    visit(c.item);
    return c;
  }

  /** Экспорт без внутренних полей. */
  function exportCollection(c) {
    return JSON.parse(JSON.stringify(c, (k, v) => (k === '_id' || k === '_open' ? undefined : v)));
  }

  function urlRaw(url) {
    if (url == null) return '';
    if (typeof url === 'string') return url;
    if (url.raw) return url.raw;
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
    const path = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
    const q = (url.query || []).filter((x) => !x.disabled).map((x) => x.key + (x.value != null ? '=' + x.value : '')).join('&');
    return (url.protocol ? url.protocol + '://' : '') + host + (url.port ? ':' + url.port : '') + (path ? '/' + path : '') + (q ? '?' + q : '');
  }

  /** Обход дерева: cb(item, parents[]) для запросов. */
  function eachRequest(items, cb, parents) {
    parents = parents || [];
    for (const it of items || []) {
      if (it.item) eachRequest(it.item, cb, parents.concat([it]));
      else cb(it, parents);
    }
  }

  function findById(c, id) {
    let found = null;
    const visit = (items, parents) => {
      for (const it of items || []) {
        if (found) return;
        if (it._id === id) { found = { item: it, parents, list: items }; return; }
        if (it.item) visit(it.item, parents.concat([it]));
      }
    };
    visit(c.item, []);
    return found;
  }

  function scriptOf(node, listen) {
    const ev = (node.event || []).find((e) => e.listen === listen);
    if (!ev || !ev.script) return '';
    const ex = ev.script.exec;
    return Array.isArray(ex) ? ex.join('\n') : ex || '';
  }

  function setScript(node, listen, code) {
    node.event = node.event || [];
    let ev = node.event.find((e) => e.listen === listen);
    if (!code || !code.trim()) { node.event = node.event.filter((e) => e !== ev); return; }
    if (!ev) { ev = { listen, script: { type: 'text/javascript', exec: [] } }; node.event.push(ev); }
    ev.script = ev.script || { type: 'text/javascript' };
    ev.script.exec = code.split('\n');
  }

  /** Унаследованная авторизация: запрос → папки (снизу вверх) → коллекция. */
  function effectiveAuth(c, item, parents) {
    const chain = [item.request].concat(parents.slice().reverse(), [c]);
    for (const n of chain) {
      if (n && n.auth && n.auth.type && n.auth.type !== 'inherit') return n.auth.type === 'noauth' ? null : n.auth;
    }
    return null;
  }

  function authParam(auth, key) {
    const list = auth[auth.type];
    if (Array.isArray(list)) { const p = list.find((x) => x.key === key); return p ? p.value : undefined; }
    if (list && typeof list === 'object') return list[key];
    return undefined;
  }

  function b64(s) {
    try { return G.btoa(unescape(encodeURIComponent(s))); } catch (e) { return Buffer.from(s, 'utf8').toString('base64'); }
  }

  /**
   * Собрать реальный запрос: подставить переменные, авторизацию, тело.
   * → {method, url, headers:[[k,v]], body, unresolved:[], bodyMode}
   */
  function buildRequest(c, item, parents, scopes) {
    const r = item.request;
    const unresolved = new Set();
    const res = (s) => { const x = resolveString(s, scopes); x.unresolved.forEach((u) => unresolved.add(u)); return x.value; };
    let url = res(urlRaw(r.url)).trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('{{')) url = 'https://' + url;
    const headers = (r.header || []).filter((h) => !h.disabled && h.key).map((h) => [res(h.key), res(h.value == null ? '' : String(h.value))]);
    const hasHeader = (n) => headers.some(([k]) => k.toLowerCase() === n.toLowerCase());
    let body;
    const b = r.body || {};
    const mode = b.mode || 'none';
    if (mode === 'raw' && b.raw) {
      body = res(b.raw);
      const lang = b.options && b.options.raw && b.options.raw.language;
      if (!hasHeader('Content-Type')) {
        if (lang === 'json' || (!lang && /^\s*[[{]/.test(body))) headers.push(['Content-Type', 'application/json']);
        else if (lang === 'xml') headers.push(['Content-Type', 'application/xml']);
        else if (lang) headers.push(['Content-Type', 'text/plain']);
      }
    } else if (mode === 'urlencoded') {
      body = (b.urlencoded || []).filter((p) => !p.disabled).map((p) => encodeURIComponent(res(p.key)) + '=' + encodeURIComponent(res(p.value || ''))).join('&');
      if (!hasHeader('Content-Type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    } else if (mode === 'formdata') {
      body = { formdata: (b.formdata || []).filter((p) => !p.disabled && p.type !== 'file').map((p) => [res(p.key), res(p.value || '')]) };
    } else if (mode === 'graphql' && b.graphql) {
      let vars = {};
      try { vars = b.graphql.variables ? JSON.parse(res(b.graphql.variables)) : {}; } catch (e) { /* оставляем пустыми */ }
      body = JSON.stringify({ query: res(b.graphql.query || ''), variables: vars });
      if (!hasHeader('Content-Type')) headers.push(['Content-Type', 'application/json']);
    }
    const auth = effectiveAuth(c, item, parents);
    if (auth) {
      if (auth.type === 'bearer') { const t = res(String(authParam(auth, 'token') || '')); if (!hasHeader('Authorization')) headers.push(['Authorization', 'Bearer ' + t]); }
      else if (auth.type === 'basic') { const u = res(String(authParam(auth, 'username') || '')), p = res(String(authParam(auth, 'password') || '')); if (!hasHeader('Authorization')) headers.push(['Authorization', 'Basic ' + b64(u + ':' + p)]); }
      else if (auth.type === 'apikey') {
        const k = res(String(authParam(auth, 'key') || 'X-API-Key')), v = res(String(authParam(auth, 'value') || ''));
        if (authParam(auth, 'in') === 'query') url += (url.indexOf('?') === -1 ? '?' : '&') + encodeURIComponent(k) + '=' + encodeURIComponent(v);
        else headers.push([k, v]);
      }
    }
    return { method: r.method || 'GET', url, headers, body, bodyMode: mode, unresolved: Array.from(unresolved), authType: auth ? auth.type : null };
  }

  /* ---------- моки ---------- */
  function mockMatch(rule, method, url) {
    if (!rule.enabled) return null;
    if (rule.method && rule.method !== 'ANY' && rule.method !== method.toUpperCase()) return null;
    let target;
    const pat = (rule.path || '').trim();
    if (/^https?:\/\//i.test(pat)) target = url.split('?')[0];
    else { try { target = new URL(url).pathname; } catch (e) { target = url.split('?')[0]; } }
    const names = [];
    const re = new RegExp('^' + pat.split('?')[0].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\\\{[^}]*\\\}\\\}/g, '[^/]+').replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }).replace(/\*/g, '.*') + '/?$');
    const m = re.exec(target);
    if (!m) return null;
    const params = {};
    names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return params;
  }

  function findMock(mocks, method, url) {
    for (const rule of mocks || []) {
      const params = mockMatch(rule, method, url);
      if (params) return { rule, params };
    }
    return null;
  }

  function mockResponse(rule, params, reqBody) {
    const scope = new Map(Object.entries(params).map(([k, v]) => ['path.' + k, v]));
    let echo = reqBody;
    if (typeof reqBody === 'string') { try { echo = JSON.parse(reqBody); } catch (e) { /* строка */ } }
    let bodyText = resolveString(rule.body || '', [scope]).value;
    if (bodyText.indexOf('{{request.body}}') !== -1) bodyText = bodyText.split('{{request.body}}').join(typeof echo === 'string' ? echo : JSON.stringify(echo || {}));
    let headers = [];
    try { headers = Object.entries(rule.headers ? JSON.parse(rule.headers) : {}); } catch (e) { headers = []; }
    if (!headers.some(([k]) => k.toLowerCase() === 'content-type') && /^\s*[[{]/.test(bodyText)) headers.push(['Content-Type', 'application/json']);
    headers.push(['X-Mock-Rule', rule.name || rule.path]);
    return { status: Number(rule.status) || 200, headers, text: bodyText };
  }

  /* ---------- отправка ---------- */
  const STATUS_TEXT = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });

  function applyProxy(url, proxy) {
    if (!proxy) return url;
    return proxy.indexOf('{url}') !== -1 ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + url;
  }

  /**
   * send(req, opts) → response {code, status, headers:[[k,v]], text, json, timeMs, size, mocked} | throws {kind, message}
   * opts: {timeout, proxy, mocks, mockMode, mockFallthrough, signal}
   */
  async function send(req, opts) {
    opts = opts || {};
    const timeout = opts.timeout || 15000;
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort();
    if (opts.signal) opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
    const t0 = (G.performance || Date).now();
    try {
      if (opts.mockMode) {
        const hit = findMock(opts.mocks, req.method, req.url);
        if (hit) {
          if (Number(hit.rule.delay) > 0) await sleep(Number(hit.rule.delay), ctrl.signal);
          if (hit.rule.network === 'error') throw Object.assign(new TypeError('Failed to fetch (имитация сетевой ошибки моком)'), { mockedNetwork: true });
          const m = mockResponse(hit.rule, hit.params, req.body);
          return finish({ status: m.status, statusText: STATUS_TEXT[m.status] || '', headers: m.headers, text: m.text, mocked: hit.rule.name || hit.rule.path });
        }
        if (opts.mockFallthrough === '501') return finish({ status: 501, statusText: 'Not Implemented', headers: [['Content-Type', 'application/json'], ['X-Mock-Rule', 'нет совпадения']], text: '{"error":"no mock rule matched"}', mocked: 'нет совпадения' });
      }
      const init = { method: req.method, headers: req.headers.filter(([k]) => !/^(host|content-length|connection|user-agent|cookie|origin|referer)$/i.test(k)), signal: ctrl.signal, redirect: 'follow' };
      if (req.body != null && !/^(GET|HEAD)$/i.test(req.method)) {
        if (typeof req.body === 'object' && req.body.formdata) { const fd = new FormData(); req.body.formdata.forEach(([k, v]) => fd.append(k, v)); init.body = fd; init.headers = init.headers.filter(([k]) => k.toLowerCase() !== 'content-type'); }
        else init.body = req.body;
      }
      const resp = await fetch(applyProxy(req.url, opts.proxy), init);
      const text = await resp.text();
      const headers = [];
      resp.headers.forEach((v, k) => headers.push([k, v]));
      return finish({ status: resp.status, statusText: resp.statusText || STATUS_TEXT[resp.status] || '', headers, text, redirected: resp.redirected, finalUrl: resp.url });
    } catch (e) {
      const timeMs = Math.round((G.performance || Date).now() - t0);
      if (e && e.name === 'AbortError') throw { kind: timedOut ? 'timeout' : 'aborted', message: timedOut ? 'Таймаут: нет ответа за ' + timeout + ' мс' : 'Запрос остановлен', timeMs };
      throw { kind: 'network', message: (e && e.message) || String(e), timeMs, mocked: !!(e && e.mockedNetwork) };
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
    }

    function finish(x) {
      const timeMs = Math.round((G.performance || Date).now() - t0);
      let json;
      const ct = (x.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
      if (x.text && (/json/i.test(ct) || /^\s*[[{]/.test(x.text))) { try { json = JSON.parse(x.text); } catch (e) { json = undefined; } }
      return { code: x.status, status: x.statusText, headers: x.headers, headersObj: Object.fromEntries(x.headers), text: x.text, json, timeMs, size: new Blob([x.text || '']).size, mocked: x.mocked || null, redirected: !!x.redirected, finalUrl: x.finalUrl, contentType: ct };
    }
  }

  /** Аргумент pm.sendRequest (строка или объект запроса Postman) → запрос для send(). */
  function specToRequest(spec, replaceIn) {
    const s = typeof spec === 'string' ? { url: spec } : spec || {};
    const rep = (x) => (typeof x === 'string' ? replaceIn(x) : x);
    const url = rep(typeof s.url === 'string' ? s.url : urlRaw(s.url));
    let headers = [];
    if (Array.isArray(s.header)) headers = s.header.filter((x) => x && !x.disabled && x.key).map((x) => [rep(x.key), rep(String(x.value == null ? '' : x.value))]);
    else if (s.header && typeof s.header === 'object') headers = Object.entries(s.header).map(([k, v]) => [rep(k), rep(String(v))]);
    const has = (n) => headers.some(([k]) => k.toLowerCase() === n);
    let body;
    const b = s.body;
    if (b && b.mode === 'raw') body = rep(b.raw || '');
    else if (b && b.mode === 'urlencoded') {
      body = (b.urlencoded || []).filter((p) => !p.disabled).map((p) => encodeURIComponent(rep(p.key)) + '=' + encodeURIComponent(rep(p.value || ''))).join('&');
      if (!has('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    } else if (typeof b === 'string') body = rep(b);
    if (typeof body === 'string' && /^\s*[[{]/.test(body) && !has('content-type')) headers.push(['Content-Type', 'application/json']);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) throw new Error('pm.sendRequest: некорректный URL «' + url + '»');
    return { method: String(s.method || 'GET').toUpperCase(), url, headers, body };
  }

  /* ---------- раннер ---------- */

  /** Контекст переменных: Map'ы, общие для прогона. */
  function makeScopes(collection, envValues, globals, data) {
    const toMap = (arr) => new Map((arr || []).filter((v) => v && v.key && v.enabled !== false && !v.disabled).map((v) => [v.key, v.value == null ? '' : String(v.value)]));
    return { local: new Map(), data: data ? new Map(Object.entries(data).map(([k, v]) => [k, String(v)])) : new Map(), env: toMap(envValues), collection: toMap(collection.variable), globals: globals || new Map() };
  }
  const scopeList = (sc) => [sc.local, sc.data, sc.env, sc.collection, sc.globals];

  /**
   * Выполнить один запрос со скриптами.
   * → result {id, name, folder, request, response?, error?, tests[], logs[], scriptErrors[], contract?, pass, iteration}
   */
  async function runItem(c, item, parents, scopes, opts) {
    opts = opts || {};
    const result = { id: item._id, name: item.name, folder: parents.map((p) => p.name).join(' / '), tests: [], logs: [], scriptErrors: [], iteration: opts.iteration || 0, startedAt: Date.now() };
    const info = { requestName: item.name, iteration: opts.iteration || 0, iterationCount: opts.iterationCount || 1 };
    const chainNodes = [c].concat(parents, [item]);
    // pm.sendRequest идёт через те же прокси, моки и таймаут, что и основной запрос
    const sender = (spec, replaceIn) => send(specToRequest(spec, replaceIn), opts).catch((e) => { throw new Error(e.message || String(e.kind)); });
    const scriptTimeout = Math.max(opts.timeout || 15000, 5000) * 2;

    // pre-request
    const preReq = buildRequest(c, item, parents, scopeList(scopes));
    const reqCtx = { method: preReq.method, url: preReq.url, headers: preReq.headers.slice(), body: typeof preReq.body === 'string' ? preReq.body : '' };
    for (const n of chainNodes) {
      const code = scriptOf(n, 'prerequest');
      if (!code) continue;
      const ctx = { request: reqCtx, scopes, info, sender, timeout: scriptTimeout };
      const r = await ATA.runScriptFull(code, ctx);
      result.logs.push(...r.logs);
      if (r.error) result.scriptErrors.push({ where: 'pre-request (' + (n === c ? 'коллекция' : n.name) + ')', ...r.error });
      if (ctx.skip) { result.skipped = true; result.pass = true; return result; }
    }
    // пересобираем после скриптов: они могли выставить переменные
    const req = buildRequest(c, item, parents, scopeList(scopes));
    // заголовки, добавленные pm.request.headers.* в pre-request
    reqCtx.headers.forEach(([k, v]) => { if (!req.headers.some(([hk]) => hk.toLowerCase() === k.toLowerCase())) req.headers.push([k, v]); });
    result.request = req;

    if (req.unresolved.length && /\{\{/.test(req.url)) {
      result.error = { kind: 'unresolved', message: 'Не подставлены переменные в URL: ' + req.unresolved.map((u) => '{{' + u + '}}').join(', ') };
      result.pass = false;
      return result;
    }
    try {
      result.response = await send(req, opts);
    } catch (e) {
      result.error = e;
      result.pass = false;
      return result;
    }

    for (const n of chainNodes) {
      const code = scriptOf(n, 'test');
      if (!code) continue;
      const ctx = { request: reqCtx, response: result.response, scopes, info, sender, timeout: scriptTimeout };
      const r = await ATA.runScriptFull(code, ctx);
      result.tests.push(...r.tests);
      result.logs.push(...r.logs);
      if (r.error) result.scriptErrors.push({ where: 'tests (' + (n === c ? 'коллекция' : n.name) + ')', ...r.error });
      if (ctx.nextRequest !== undefined) result.nextRequest = ctx.nextRequest;
    }

    if (opts.contract && result.response) {
      result.contract = ATA.checkContract(opts.contract, req.method, req.url, result.response.code, result.response.json, opts.contractStrict);
    }
    const contractErrors = result.contract ? result.contract.issues.filter((i) => i.kind !== 'extra-warn' && i.kind !== 'undocumented') : [];
    result.pass = result.tests.every((t) => t.pass) && result.scriptErrors.length === 0 && contractErrors.length === 0;
    return result;
  }

  /**
   * Прогон набора запросов. targets: [{item, parents}]. data: массив строк данных (итерации).
   * onResult(result) вызывается после каждого запроса. Поддерживает pm.execution.setNextRequest.
   */
  async function runCollection(c, targets, opts) {
    const iterations = opts.data && opts.data.length ? opts.data.length : Math.max(1, opts.iterations || 1);
    const globals = opts.globals || new Map();
    const envMap = opts.envMap; // общий Map окружения, изменения видны в UI
    const results = [];
    for (let it = 0; it < iterations; it++) {
      const scopes = makeScopes(c, [], globals, opts.data ? opts.data[it] : null);
      if (envMap) scopes.env = envMap;
      if (opts.collectionMap) scopes.collection = opts.collectionMap;
      let i = 0;
      let guard = 0;
      while (i < targets.length) {
        if (opts.signal && opts.signal.aborted) return results;
        if (++guard > targets.length * 20) break; // защита от бесконечного setNextRequest
        const t = targets[i];
        const r = await runItem(c, t.item, t.parents, scopes, Object.assign({}, opts, { iteration: it, iterationCount: iterations }));
        results.push(r);
        opts.onResult && opts.onResult(r, results);
        if (!r.pass && opts.stopOnFail) return results;
        if (r.nextRequest === null) break;
        if (typeof r.nextRequest === 'string') {
          const j = targets.findIndex((x) => x.item.name === r.nextRequest || x.item._id === r.nextRequest);
          i = j >= 0 ? j : i + 1;
        } else i++;
        if (opts.delay) await sleep(opts.delay, opts.signal).catch(() => {});
      }
    }
    return results;
  }

  /* ---------- cURL ---------- */
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  function toCurl(req) {
    const parts = ['curl', '-X', req.method, shq(req.url)];
    (req.headers || []).forEach(([k, v]) => parts.push('-H', shq(k + ': ' + v)));
    if (typeof req.body === 'string' && req.body) parts.push('--data-raw', shq(req.body));
    else if (req.body && req.body.formdata) req.body.formdata.forEach(([k, v]) => parts.push('-F', shq(k + '=' + v)));
    return parts.join(' ');
  }

  function shellSplit(s) {
    const out = [];
    let cur = '', q = null, any = false;
    s = s.replace(/\\\r?\n/g, ' ');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === q) q = null;
        else if (ch === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
        else cur += ch;
      } else if (ch === "'" || ch === '"') { q = ch; any = true; }
      else if (ch === '\\' && i + 1 < s.length) cur += s[++i];
      else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
      else cur += ch;
    }
    if (cur || any) out.push(cur);
    return out;
  }

  /** Простой разбор cURL → Postman item. */
  function fromCurl(text) {
    const a = shellSplit(text.trim());
    if (!a.length || a[0] !== 'curl') throw new Error('Команда должна начинаться с curl');
    let method = null, url = '', body = null;
    const header = [];
    let auth = null;
    for (let i = 1; i < a.length; i++) {
      const x = a[i];
      const next = () => a[++i];
      if (x === '-X' || x === '--request') method = next().toUpperCase();
      else if (x === '-H' || x === '--header') { const h = next(); const k = h.indexOf(':'); if (k > 0) header.push({ key: h.slice(0, k).trim(), value: h.slice(k + 1).trim() }); }
      else if (/^(-d|--data|--data-raw|--data-binary|--data-ascii|--json)$/.test(x)) { const d = next(); body = body ? body + '&' + d : d; if (x === '--json' && !header.some((h) => /content-type/i.test(h.key))) header.push({ key: 'Content-Type', value: 'application/json' }); }
      else if (x === '-u' || x === '--user') { const u = next(); const k = u.indexOf(':'); auth = { type: 'basic', basic: [{ key: 'username', value: k >= 0 ? u.slice(0, k) : u }, { key: 'password', value: k >= 0 ? u.slice(k + 1) : '' }] }; }
      else if (x === '--url') url = next();
      else if (/^-(b|A|e|o|w|m|-cookie|-user-agent|-referer|-output|-max-time|-connect-timeout)$/.test(x)) next();
      else if (x.startsWith('-')) { /* флаги без значения: -s, -L, -k, -i, --compressed... */ }
      else if (!url) url = x;
    }
    if (!url) throw new Error('В команде не найден URL');
    const item = newRequest(url.replace(/^https?:\/\/[^/]+/, '') || url, method || (body != null ? 'POST' : 'GET'), url);
    item.request.header = header;
    if (body != null) item.request.body = { mode: 'raw', raw: body, options: { raw: { language: /^\s*[[{]/.test(body) ? 'json' : 'text' } } };
    if (auth) item.request.auth = auth;
    return item;
  }

  /* ---------- CSV ---------- */
  function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',' || ch === ';') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    const clean = rows.filter((r) => r.some((x) => x !== ''));
    if (clean.length < 2) return [];
    const head = clean[0].map((h) => h.trim());
    return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])));
  }

  function parseDataFile(text) {
    const t = text.trim();
    if (t.startsWith('[')) {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr)) throw new Error('JSON-файл данных должен быть массивом объектов');
      return arr;
    }
    return parseCsv(text);
  }

  /* ---------- статистика ---------- */
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }
  function stats(values) {
    const s = values.slice().sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return { count: s.length, min: s[0] || 0, max: s[s.length - 1] || 0, avg: s.length ? sum / s.length : 0, p50: percentile(s, 50), p90: percentile(s, 90), p95: percentile(s, 95), p99: percentile(s, 99) };
  }

  /**
   * Нагрузочный прогон одного собранного запроса.
   * opts: {total, concurrency, timeout, proxy, mocks, mockMode, signal, onProgress, rebuild()}
   */
  async function loadTest(buildFn, opts) {
    const samples = [];
    const statusCounts = {};
    let started = 0;
    const t0 = (G.performance || Date).now();
    async function worker() {
      while (started < opts.total) {
        if (opts.signal && opts.signal.aborted) return;
        const n = started++;
        const req = buildFn();
        const s0 = (G.performance || Date).now() - t0;
        try {
          const r = await send(req, opts);
          samples.push({ n, at: s0, ms: r.timeMs, code: r.code, ok: r.code < 400 });
          statusCounts[r.code] = (statusCounts[r.code] || 0) + 1;
        } catch (e) {
          samples.push({ n, at: s0, ms: e.timeMs || 0, code: e.kind, ok: false });
          statusCounts[e.kind] = (statusCounts[e.kind] || 0) + 1;
        }
        opts.onProgress && opts.onProgress(samples, statusCounts);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
    const elapsed = ((G.performance || Date).now() - t0) / 1000;
    const okS = samples.filter((x) => x.ok);
    return { samples, statusCounts, elapsed, rps: elapsed > 0 ? samples.length / elapsed : 0, errorRate: samples.length ? (samples.length - okS.length) / samples.length : 0, latency: stats(samples.filter((x) => typeof x.code === 'number').map((x) => x.ms)) };
  }

  /* ---------- query-параметры и переменные ---------- */
  /** Разбить raw-URL на базу и параметры. Значения не декодируются: в них могут быть {{переменные}}. */
  function splitQuery(raw) {
    raw = raw || '';
    const hashAt = raw.indexOf('#');
    const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
    const noHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
    const qAt = noHash.indexOf('?');
    if (qAt < 0) return { base: noHash, params: [], hash };
    const params = noHash.slice(qAt + 1).split('&').filter((p) => p !== '').map((p) => {
      const eq = p.indexOf('=');
      return eq < 0 ? { key: p, value: '' } : { key: p.slice(0, eq), value: p.slice(eq + 1) };
    });
    return { base: noHash.slice(0, qAt), params, hash };
  }
  function joinQuery(base, params, hash) {
    const q = (params || []).filter((p) => p.key && !p.disabled).map((p) => p.key + (p.value !== '' && p.value != null ? '=' + p.value : '')).join('&');
    return base + (q ? '?' + q : '') + (hash || '');
  }

  /** Все {{переменные}} запроса: URL, заголовки, тело, авторизация (с учётом наследования). */
  function varNames(c, item, parents) {
    const r = item.request || {};
    const texts = [urlRaw(r.url)];
    (r.header || []).filter((x) => !x.disabled).forEach((x) => texts.push(x.key, x.value));
    const b = r.body || {};
    if (b.mode === 'raw') texts.push(b.raw);
    (b.urlencoded || b.formdata || []).forEach((x) => texts.push(x.key, x.value));
    if (b.graphql) texts.push(b.graphql.query, b.graphql.variables);
    const auth = effectiveAuth(c, item, parents || []);
    if (auth && Array.isArray(auth[auth.type])) auth[auth.type].forEach((p) => texts.push(p.value));
    const names = new Set();
    texts.forEach((t) => { if (typeof t === 'string') for (const m of t.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) names.add(m[1]); });
    return Array.from(names);
  }
  const isDynamicVar = (n) => n.startsWith('$') && !!DYNAMIC[n];

  Object.assign(ATA, {
    splitQuery, joinQuery, varNames, isDynamicVar, specToRequest, DYNAMIC_VARS: DYNAMIC,
    uid, uuid, clone, resolveString, newCollection, newRequest, normalizeCollection, exportCollection, urlRaw, eachRequest, findById,
    scriptOf, setScript, effectiveAuth, buildRequest, findMock, mockMatch, mockResponse, send, makeScopes, scopeList, runItem, runCollection,
    toCurl, fromCurl, parseCsv, parseDataFile, stats, loadTest, sleep, STATUS_TEXT, SCHEMA_V21,
  });
})(typeof window !== 'undefined' ? window : globalThis);
