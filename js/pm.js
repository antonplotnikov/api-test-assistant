/* Песочница Postman-скриптов: pm.*, pm.expect (подмножество chai), legacy tests[]/postman.*. */
(function (G) {
  'use strict';
  const ATA = (G.ATA = G.ATA || {});

  class AssertionError extends Error { constructor(m) { super(m); this.name = 'AssertionError'; } }
  class UnsupportedError extends Error { constructor(m) { super(m); this.name = 'UnsupportedError'; } }

  function show(v) {
    if (typeof v === 'string') return "'" + (v.length > 80 ? v.slice(0, 77) + '…' : v) + "'";
    if (v && v.__isResponse) return 'response(' + v.code + ')';
    try { const s = JSON.stringify(v); return s && s.length > 80 ? s.slice(0, 77) + '…' : String(s); } catch (e) { return String(v); }
  }

  const CHAINS = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'but', 'itself', 'deep', 'any', 'all', 'own', 'nested'];

  function getPath(obj, path) {
    return String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function includes(hay, needle) {
    if (typeof hay === 'string') return hay.indexOf(String(needle)) !== -1;
    if (Array.isArray(hay)) return hay.some((x) => ATA.deepEqual(x, needle));
    if (hay && typeof hay === 'object' && needle && typeof needle === 'object') return Object.keys(needle).every((k) => ATA.deepEqual(hay[k], needle[k]));
    return false;
  }

  function expect(subject, message) {
    const st = { negate: false, nested: false };
    const a = {};
    const assert = (cond, msg, negMsg) => {
      const pass = st.negate ? !cond : !!cond;
      if (!pass) throw new AssertionError((message ? message + ': ' : '') + (st.negate ? negMsg || 'NOT (' + msg + ')' : msg));
      return a;
    };
    const s = () => subject;
    const isResp = () => subject && subject.__isResponse;

    CHAINS.forEach((c) => Object.defineProperty(a, c, { get() { if (c === 'nested') st.nested = true; return a; } }));
    Object.defineProperty(a, 'not', { get() { st.negate = !st.negate; return a; } });

    const getters = {
      ok: () => (isResp() ? assert(subject.code >= 200 && subject.code < 300, 'ожидался успешный статус 2xx, получен ' + subject.code, 'ожидался неуспешный статус, получен ' + subject.code) : assert(!!subject, 'expected ' + show(subject) + ' to be truthy')),
      true: () => assert(subject === true, 'expected ' + show(subject) + ' to be true'),
      false: () => assert(subject === false, 'expected ' + show(subject) + ' to be false'),
      null: () => assert(subject === null, 'expected ' + show(subject) + ' to be null'),
      undefined: () => assert(subject === undefined, 'expected ' + show(subject) + ' to be undefined'),
      NaN: () => assert(Number.isNaN(subject), 'expected ' + show(subject) + ' to be NaN'),
      exist: () => assert(subject !== null && subject !== undefined, 'expected value to exist', 'expected ' + show(subject) + ' not to exist'),
      empty: () => assert(subject == null ? false : typeof subject === 'string' || Array.isArray(subject) ? subject.length === 0 : Object.keys(subject).length === 0, 'expected ' + show(subject) + ' to be empty'),
      json: () => assert(isResp() && subject._json !== undefined, 'ожидался JSON в теле ответа'),
      success: () => assert(isResp() && subject.code >= 200 && subject.code < 300, 'ожидался 2xx, получен ' + (subject && subject.code)),
      error: () => assert(isResp() && subject.code >= 400, 'ожидался 4xx/5xx, получен ' + (subject && subject.code)),
      clientError: () => assert(isResp() && subject.code >= 400 && subject.code < 500, 'ожидался 4xx, получен ' + (subject && subject.code)),
      serverError: () => assert(isResp() && subject.code >= 500, 'ожидался 5xx, получен ' + (subject && subject.code)),
      info: () => assert(isResp() && subject.code < 200, 'ожидался 1xx'),
      redirection: () => assert(isResp() && subject.code >= 300 && subject.code < 400, 'ожидался 3xx'),
      badRequest: () => assert(isResp() && subject.code === 400, 'ожидался 400, получен ' + (subject && subject.code)),
      unauthorized: () => assert(isResp() && subject.code === 401, 'ожидался 401, получен ' + (subject && subject.code)),
      forbidden: () => assert(isResp() && subject.code === 403, 'ожидался 403, получен ' + (subject && subject.code)),
      notFound: () => assert(isResp() && subject.code === 404, 'ожидался 404, получен ' + (subject && subject.code)),
      rateLimited: () => assert(isResp() && subject.code === 429, 'ожидался 429, получен ' + (subject && subject.code)),
      accepted: () => assert(isResp() && subject.code === 202, 'ожидался 202, получен ' + (subject && subject.code)),
      withBody: () => assert(isResp() && subject._text.length > 0, 'ожидалось непустое тело'),
    };
    Object.entries(getters).forEach(([k, fn]) => Object.defineProperty(a, k, { get: fn }));

    const methods = {
      equal: (v) => assert(subject === v, 'expected ' + show(subject) + ' to equal ' + show(v), 'expected ' + show(subject) + ' to not equal ' + show(v)),
      eql: (v) => assert(ATA.deepEqual(subject, v), 'expected ' + show(subject) + ' to deeply equal ' + show(v), 'expected ' + show(subject) + ' to not deeply equal ' + show(v)),
      above: (n) => assert(subject > n, 'expected ' + show(subject) + ' to be above ' + n),
      below: (n) => assert(subject < n, 'expected ' + show(subject) + ' to be below ' + n),
      least: (n) => assert(subject >= n, 'expected ' + show(subject) + ' to be at least ' + n),
      most: (n) => assert(subject <= n, 'expected ' + show(subject) + ' to be at most ' + n),
      within: (x, y) => assert(subject >= x && subject <= y, 'expected ' + show(subject) + ' to be within ' + x + '..' + y),
      include: (v) => assert(includes(subject, v), 'expected ' + show(subject) + ' to include ' + show(v), 'expected ' + show(subject) + ' to not include ' + show(v)),
      oneOf: (arr) => assert(arr.some((x) => ATA.deepEqual(x, subject)), 'expected ' + show(subject) + ' to be one of ' + show(arr)),
      match: (re) => assert(new RegExp(re).test(String(subject)), 'expected ' + show(subject) + ' to match ' + re),
      string: (v) => assert(typeof subject === 'string' && subject.indexOf(v) !== -1, 'expected ' + show(subject) + ' to contain ' + show(v)),
      a: (t) => {
        const actual = ATA.typeOf(subject) === 'integer' ? 'number' : ATA.typeOf(subject);
        return assert(actual === String(t).toLowerCase(), 'expected ' + show(subject) + ' to be a ' + t + ' (получен ' + actual + ')');
      },
      instanceOf: (C) => assert(subject instanceof C, 'expected ' + show(subject) + ' to be instance of ' + (C && C.name)),
      lengthOf: (n) => assert(subject != null && subject.length === n, 'expected ' + show(subject) + ' to have length ' + n + ' (получено ' + (subject == null ? '—' : subject.length) + ')'),
      keys: (...ks) => {
        const want = ks.length === 1 && Array.isArray(ks[0]) ? ks[0] : ks;
        return assert(subject && typeof subject === 'object' && want.every((k) => k in subject), 'expected ' + show(subject) + ' to have keys ' + show(want));
      },
      members: (arr) => assert(Array.isArray(subject) && arr.every((x) => includes(subject, x)), 'expected ' + show(subject) + ' to have members ' + show(arr)),
      // response-специфичные
      status: (code) => {
        if (!isResp()) throw new UnsupportedError('.status() применим только к pm.response');
        if (typeof code === 'string') return assert(subject.status === code, 'ожидался статус "' + code + '", получен "' + subject.status + '"');
        return assert(subject.code === code, 'ожидался статус ' + code + ', получен ' + subject.code, 'статус не должен быть ' + code);
      },
      header: (name, value) => {
        if (!isResp()) throw new UnsupportedError('.header() применим только к pm.response');
        const v = subject.headers.get(name);
        if (value === undefined) return assert(v != null, 'нет заголовка ' + name, 'заголовок ' + name + ' присутствует');
        return assert(v === value, 'заголовок ' + name + ': ожидалось ' + show(value) + ', получено ' + show(v));
      },
      body: (b) => {
        if (!isResp()) throw new UnsupportedError('.body() применим только к pm.response');
        if (b === undefined) return assert(subject._text.length > 0, 'ожидалось непустое тело');
        if (typeof b === 'string') return assert(subject._text === b, 'тело ответа не совпадает');
        return assert(ATA.deepEqual(subject._json, b), 'JSON тела не совпадает');
      },
      jsonBody: (path, val) => {
        if (!isResp()) throw new UnsupportedError('.jsonBody() применим только к pm.response');
        if (subject._json === undefined) return assert(false, 'тело ответа не JSON');
        if (path === undefined) return assert(true, '');
        if (typeof path === 'object') return assert(ATA.deepEqual(subject._json, path), 'JSON тела не совпадает');
        const v = getPath(subject._json, path);
        if (val === undefined) return assert(v !== undefined, 'в JSON нет пути ' + path);
        return assert(ATA.deepEqual(v, val), 'JSON ' + path + ': ожидалось ' + show(val) + ', получено ' + show(v));
      },
      jsonSchema: (schema) => {
        const data = isResp() ? subject._json : subject;
        const errs = ATA.validate(schema, data, { root: schema });
        return assert(errs.length === 0, 'схема не совпала: ' + errs.slice(0, 3).map((e) => e.path + ' ' + e.message).join('; ') + (errs.length > 3 ? ' (+' + (errs.length - 3) + ')' : ''));
      },
      responseTime: () => { throw new UnsupportedError('используйте pm.expect(pm.response.responseTime).to.be.below(...)'); },
    };
    const aliases = { equals: 'equal', eq: 'equal', eqls: 'eql', gt: 'above', greaterThan: 'above', lt: 'below', lessThan: 'below', gte: 'least', lte: 'most', includes: 'include', contain: 'include', contains: 'include', an: 'a', instanceof: 'instanceOf', key: 'keys', matches: 'match', length: 'lengthOf' };
    Object.entries(methods).forEach(([k, fn]) => { a[k] = (...args) => fn(...args); });
    Object.entries(aliases).forEach(([k, t]) => { a[k] = (...args) => methods[t](...args); });
    a.property = function (name, val) {
      const actual = st.nested ? getPath(subject, name) : subject == null ? undefined : subject[name];
      const has = subject != null && (st.nested ? actual !== undefined : Object.prototype.hasOwnProperty.call(Object(subject), name));
      if (arguments.length > 1) return assert(has && ATA.deepEqual(actual, val), 'expected property ' + name + ' = ' + show(val) + ', получено ' + show(actual));
      return assert(has, 'expected ' + show(subject) + ' to have property ' + show(name), 'expected ' + show(subject) + ' to not have property ' + show(name));
    };
    return a;
  }
  expect.fail = (m) => { throw new AssertionError(m || 'expect.fail()'); };

  /** Хранилище переменных с API pm.environment / pm.collectionVariables. */
  function varScope(map, onChange) {
    return {
      get: (k) => (map.has(k) ? map.get(k) : undefined),
      set: (k, v) => { map.set(String(k), v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)); onChange && onChange(k); },
      unset: (k) => { map.delete(k); onChange && onChange(k); },
      has: (k) => map.has(k),
      clear: () => { map.clear(); onChange && onChange(); },
      toObject: () => Object.fromEntries(map),
      replaceIn: (str) => ATA.resolveString ? ATA.resolveString(str, ATA._activeScopes || []) : str,
    };
  }

  /**
   * runScript(code, ctx) → {tests:[{name,pass,message}], logs:[], error}
   * ctx: {response?, request, scopes:{env, collection, globals, local, data}, info}
   */
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const errInfo = (e) => ({ name: (e && e.name) || 'Error', message: (e && e.message) || String(e), unsupported: !!(e && (e.name === 'UnsupportedError' || e.name === 'ReferenceError' || e.name === 'SyntaxError')) });

  function runScript(code, ctx) {
    const tests = [];
    const logs = [];
    const pendingSet = new Set();
    const result = { tests, logs, error: null, asyncErrors: [], _pending: pendingSet };
    if (!code || !code.trim()) return result;
    // асинхронная работа скрипта (pm.sendRequest, async-тесты, await) — ждём её в runScriptFull
    const track = (p) => { const t = Promise.resolve(p).catch(() => {}).finally(() => pendingSet.delete(t)); pendingSet.add(t); return t; };
    const runCb = (fn) => {
      try { const r = fn(); if (r && typeof r.then === 'function') track(Promise.resolve(r).catch((e) => result.asyncErrors.push(errInfo(e)))); }
      catch (e) { result.asyncErrors.push(errInfo(e)); }
    };

    const sc = ctx.scopes;
    const variables = {
      get: (k) => [sc.local, sc.data, sc.env, sc.collection, sc.globals].reduce((acc, m) => (acc !== undefined ? acc : m && m.has(k) ? m.get(k) : undefined), undefined),
      set: (k, v) => sc.local.set(String(k), v == null ? '' : String(v)),
      has: (k) => [sc.local, sc.data, sc.env, sc.collection, sc.globals].some((m) => m && m.has(k)),
      unset: (k) => sc.local.delete(k),
      replaceIn: (str) => ATA.resolveString(str, [sc.local, sc.data, sc.env, sc.collection, sc.globals]).value,
      toObject: () => Object.assign({}, ...[sc.globals, sc.collection, sc.env, sc.data, sc.local].map((m) => (m ? Object.fromEntries(m) : {}))),
    };
    const env = varScope(sc.env); env.replaceIn = variables.replaceIn;
    const coll = varScope(sc.collection); coll.replaceIn = variables.replaceIn;
    const glob = varScope(sc.globals); glob.replaceIn = variables.replaceIn;

    const pm = {
      test(name, fn) {
        const failed = (e) => ({ name, pass: false, message: (e && e.name === 'AssertionError' ? '' : (e && e.name) + ': ') + (e && e.message), unsupported: !!(e && (e.name === 'UnsupportedError' || e.name === 'ReferenceError')) });
        try {
          const r = typeof fn === 'function' ? fn() : undefined;
          if (r && typeof r.then === 'function') {
            const entry = { name, pass: true, message: '' };
            tests.push(entry);
            track(Promise.resolve(r).catch((e) => Object.assign(entry, failed(e))));
            return pm;
          }
          tests.push({ name, pass: true, message: '' });
        } catch (e) {
          tests.push(failed(e));
        }
        return pm;
      },
      expect,
      environment: env,
      collectionVariables: coll,
      globals: glob,
      variables,
      iterationData: { get: (k) => (sc.data && sc.data.has(k) ? sc.data.get(k) : undefined), has: (k) => !!(sc.data && sc.data.has(k)), toObject: () => (sc.data ? Object.fromEntries(sc.data) : {}) },
      info: Object.assign({ eventName: ctx.response ? 'test' : 'prerequest', iteration: 0, iterationCount: 1, requestName: '' }, ctx.info || {}),
      request: ctx.request ? makeRequestApi(ctx.request) : undefined,
      /** pm.sendRequest(urlOrRequest, callback?) — как в Postman: с колбэком или через await. */
      sendRequest(spec, cb) {
        if (!ctx.sender) throw new UnsupportedError('pm.sendRequest недоступен в этом контексте');
        const label = typeof spec === 'string' ? spec : spec && (typeof spec.url === 'string' ? spec.url : spec.url && spec.url.raw) || '';
        const p = Promise.resolve().then(() => ctx.sender(spec, variables.replaceIn)).then(
          (resp) => {
            logs.push({ level: 'info', text: 'pm.sendRequest ' + ((spec && spec.method) || 'GET') + ' ' + variables.replaceIn(String(label)) + ' → ' + resp.code + ' (' + resp.timeMs + ' мс)' });
            const api = makeResponseApi(resp);
            if (cb) runCb(() => cb(null, api));
            return api;
          },
          (err) => {
            const e = err instanceof Error ? err : new Error((err && err.message) || String(err));
            logs.push({ level: 'error', text: 'pm.sendRequest ' + variables.replaceIn(String(label)) + ' → ' + e.message });
            if (cb) { runCb(() => cb(e, null)); return null; }
            throw e;
          });
        track(p);
        return p;
      },
      execution: { setNextRequest(n) { ctx.nextRequest = n; }, skipRequest() { ctx.skip = true; } },
      cookies: { get: () => undefined, has: () => false, toObject: () => ({}) },
    };
    pm.test.skip = (name) => { tests.push({ name, pass: true, skipped: true, message: 'пропущен' }); return pm; };
    if (ctx.response) pm.response = makeResponseApi(ctx.response);

    const legacyTests = {};
    const postman = {
      setEnvironmentVariable: (k, v) => env.set(k, v),
      getEnvironmentVariable: (k) => env.get(k),
      clearEnvironmentVariable: (k) => env.unset(k),
      setGlobalVariable: (k, v) => glob.set(k, v),
      getGlobalVariable: (k) => glob.get(k),
      setNextRequest: (n) => { ctx.nextRequest = n; },
    };
    const consoleApi = {};
    ['log', 'info', 'warn', 'error', 'debug'].forEach((lvl) => {
      consoleApi[lvl] = (...args) => logs.push({ level: lvl, text: args.map((x) => (typeof x === 'string' ? x : show(x))).join(' ') });
    });
    const req = () => { throw new UnsupportedError('require() не поддерживается в браузерном раннере'); };
    const r = ctx.response;
    try {
      // Скрипт выполняется в контексте страницы, как и в Postman: запускайте только свои/доверенные коллекции.
      // await на верхнем уровне (как в Postman) — компилируем как async-функцию
      const Ctor = /\bawait\b/.test(code) ? AsyncFunction : Function;
      const fn = new Ctor('pm', 'console', 'tests', 'postman', 'require', 'responseBody', 'responseCode', 'responseTime', 'responseHeaders', 'xml2Json', '"use strict";\n' + code);
      const ret = fn(pm, consoleApi, legacyTests, postman, req, r ? r.text : undefined, r ? { code: r.code, name: r.status } : undefined, r ? r.timeMs : undefined, r ? r.headersObj : undefined, () => { throw new UnsupportedError('xml2Json не поддерживается'); });
      if (ret && typeof ret.then === 'function') track(ret.catch((e) => { result.error = result.error || errInfo(e); }));
    } catch (e) {
      result.error = errInfo(e);
    }
    Object.entries(legacyTests).forEach(([name, v]) => tests.push({ name, pass: !!v, message: v ? '' : 'tests["' + name + '"] = false' }));
    return result;
  }

  /** Выполнить скрипт и дождаться его асинхронной части (pm.sendRequest, async-тесты). */
  async function runScriptFull(code, ctx) {
    const r = runScript(code, ctx);
    const deadline = Date.now() + (ctx.timeout || 30000);
    while (r._pending.size && Date.now() < deadline) {
      const left = deadline - Date.now();
      let timer;
      await Promise.race([Promise.all(Array.from(r._pending)), new Promise((res) => { timer = setTimeout(res, left); })]);
      clearTimeout(timer);
    }
    if (r._pending.size) r.error = r.error || { name: 'TimeoutError', message: 'асинхронная часть скрипта не завершилась за ' + Math.round((ctx.timeout || 30000) / 1000) + ' с', unsupported: false };
    if (!r.error && r.asyncErrors.length) r.error = r.asyncErrors[0];
    delete r._pending;
    return r;
  }

  function makeHeadersApi(pairs) {
    const lower = pairs.map(([k, v]) => [k.toLowerCase(), v]);
    return {
      get: (n) => { const f = lower.find(([k]) => k === String(n).toLowerCase()); return f ? f[1] : undefined; },
      has: (n, v) => lower.some(([k, val]) => k === String(n).toLowerCase() && (v === undefined || val === v)),
      toObject: () => Object.fromEntries(pairs),
      all: () => pairs.map(([key, value]) => ({ key, value })),
      each: (cb) => pairs.forEach(([key, value]) => cb({ key, value })),
    };
  }

  function makeResponseApi(r) {
    const api = {
      __isResponse: true,
      code: r.code,
      status: r.status,
      responseTime: r.timeMs,
      responseSize: r.size,
      headers: makeHeadersApi(r.headers),
      _json: r.json,
      _text: r.text || '',
      json() { if (r.json === undefined) throw new SyntaxError('тело ответа не является JSON: ' + (r.text || '').slice(0, 60)); return r.json; },
      text() { return r.text || ''; },
      reason() { return r.status; },
    };
    Object.defineProperty(api, 'to', { get: () => expect(api).to });
    return api;
  }

  function makeRequestApi(q) {
    return {
      url: { toString: () => q.url, getHost: () => { try { return new URL(q.url).host; } catch (e) { return ''; } }, getPath: () => { try { return new URL(q.url).pathname; } catch (e) { return ''; } } },
      method: q.method,
      headers: Object.assign(makeHeadersApi(q.headers || []), {
        add: (h) => q.headers.push([h.key, h.value]),
        upsert: (h) => { const i = q.headers.findIndex(([k]) => k.toLowerCase() === h.key.toLowerCase()); if (i >= 0) q.headers[i] = [h.key, h.value]; else q.headers.push([h.key, h.value]); },
        remove: (n) => { q.headers = q.headers.filter(([k]) => k.toLowerCase() !== String(n).toLowerCase()); },
      }),
      body: { raw: q.body, toString: () => q.body || '' },
    };
  }

  Object.assign(ATA, { expect, runScript, runScriptFull, AssertionError, UnsupportedError, getPath });
})(typeof window !== 'undefined' ? window : globalThis);
