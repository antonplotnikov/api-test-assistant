/* Пассивный сканер безопасности: анализирует уже полученные ответы (ничего не отправляет). */
(function (G) {
  'use strict';
  const ATA = (G.ATA = G.ATA || {});

  const OWASP = {
    API1: 'API1 Broken Object Level Authorization',
    API2: 'API2 Broken Authentication',
    API3: 'API3 Broken Object Property Level Authorization',
    API4: 'API4 Unrestricted Resource Consumption',
    API8: 'API8 Security Misconfiguration',
  };
  const SEV_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

  // заголовки, которые браузер отдаёт JS при cross-origin без Access-Control-Expose-Headers
  const SAFELISTED = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);

  const LEAK_PATTERNS = [
    [/Traceback \(most recent call last\)/, 'Python traceback'],
    [/\bat [\w.$<>]+ \([^)\n]*:\d+:\d+\)/, 'стектрейс JavaScript/Node.js'],
    [/\bat [\w.$]+\([\w]+\.java:\d+\)/, 'стектрейс Java'],
    [/\b(java|javax|org\.springframework)\.[\w.]+(Exception|Error)\b/, 'исключение Java'],
    [/\bSystem\.\w+Exception\b|   at [\w.]+\(.*\) in .*:line \d+/, 'исключение .NET'],
    [/SQLSTATE\[|SQLException|ORA-\d{5}|syntax error at or near|You have an error in your SQL syntax|PG::\w+Error|sqlite3?\.\w*Error/i, 'текст SQL-ошибки'],
    [/Whitelabel Error Page|DisallowedHost|Whoops, looks like something went wrong|<title>.*Exception.*<\/title>/i, 'отладочная страница фреймворка'],
    [/\/(home|var|usr|opt|srv)\/[\w.-]+\/[\w./-]+\.(js|ts|py|rb|php|java|go)\b|[A-Z]:\\[\w\\ .-]+\.(cs|java|py|js)\b/, 'путь к файлу на сервере'],
  ];

  const SECRET_KEYS = /^(password|passwd|pwd|pass|secret|client_?secret|private_?key|api_?key|apikey|access_?key|secret_?key|ssn|card_?number|cardnumber|pan|cvv|cvc|pin)$/i;
  const TOKEN_KEYS = /^(token|access_?token|refresh_?token|id_?token|session_?id|jwt)$/i;
  const PII_KEYS = /^(email|phone|phone_?number|birth_?date|dob|passport|address|iban)$/i;

  function luhn(num) {
    let sum = 0, alt = false;
    for (let i = num.length - 1; i >= 0; i--) {
      let n = Number(num[i]);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }

  /** Обход JSON: cb(key, value, path) для всех полей (с ограничением объёма). */
  function walkJson(v, cb, path, state) {
    state = state || { n: 0 };
    path = path || '$';
    if (state.n++ > 20000 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.slice(0, 200).forEach((x, i) => walkJson(x, cb, path + '[' + i + ']', state)); return; }
    for (const k of Object.keys(v)) {
      cb(k, v[k], path + '.' + k);
      walkJson(v[k], cb, path + '.' + k, state);
    }
  }

  const host = (url) => { try { return new URL(url).hostname; } catch (e) { return ''; } };
  const isLocal = (url) => /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$)/.test(host(url));

  /**
   * scanResult(result) → [{id, sev, owasp, title, detail}]
   * Работает только с тем, что видно в ответе. headersVisible=false, если браузер скрыл заголовки (CORS).
   */
  function scanResult(r) {
    const out = [];
    const add = (id, sev, owasp, title, detail) => out.push({ id, sev, owasp, title, detail: detail || '' });
    const req = r.request || {};
    const resp = r.response;
    const url = req.url || '';
    const reqHeader = (n) => (req.headers || []).find(([k]) => k.toLowerCase() === n.toLowerCase());

    // транспорт и секреты в запросе
    if (/^http:\/\//i.test(url) && !isLocal(url)) {
      add('no-https', reqHeader('Authorization') ? 'high' : 'medium', 'API8', 'Запрос по HTTP без шифрования', reqHeader('Authorization') ? 'Заголовок Authorization уходит открытым текстом — токен можно перехватить.' : 'Данные передаются открытым текстом.');
    }
    const q = url.split('?')[1] || '';
    const secretParam = q.split('&').map((p) => p.split('=')[0]).find((k) => /^(access_?token|token|api_?key|apikey|key|secret|password|session)$/i.test(decodeURIComponent(k || '')));
    if (secretParam) add('secret-in-url', 'medium', 'API2', 'Секрет в URL: параметр «' + secretParam + '»', 'Query-параметры оседают в логах прокси, балансировщиков и в истории браузера. Передавайте секреты в заголовке.');

    if (!resp) return out;
    const names = resp.headers.map(([k]) => k.toLowerCase());
    // заголовки мока — это настройки правила, а не реального сервера: их не проверяем
    const headersVisible = !resp.mocked && names.some((n) => !SAFELISTED.has(n));
    const hdr = (n) => (resp.headers.find(([k]) => k.toLowerCase() === n) || [])[1];
    const ct = (hdr('content-type') || '').toLowerCase();
    const text = resp.text || '';

    // утечки в теле
    for (const [re, label] of LEAK_PATTERNS) {
      const m = re.exec(text);
      if (m) { add('leak-' + label, resp.code >= 500 ? 'high' : 'medium', 'API8', 'В ответе ' + label, 'Фрагмент: «' + m[0].slice(0, 120) + '». Детали реализации помогают атакующему; отдавайте клиенту общее сообщение и id ошибки.'); break; }
    }
    const ip = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/.exec(text);
    if (ip) add('internal-ip', 'low', 'API8', 'Внутренний IP-адрес в ответе: ' + ip[0], 'Раскрывает топологию внутренней сети.');

    // чувствительные поля в JSON
    if (resp.json !== undefined) {
      const secrets = [], tokens = [], pii = new Set();
      walkJson(resp.json, (k, v, p) => {
        if (v == null || v === '' || typeof v === 'object') return;
        if (SECRET_KEYS.test(k)) secrets.push(p);
        else if (TOKEN_KEYS.test(k)) tokens.push(p);
        else if (PII_KEYS.test(k)) pii.add(k);
      });
      if (secrets.length) add('secret-field', 'high', 'API3', 'Ответ содержит секретные поля: ' + secrets.slice(0, 4).join(', ') + (secrets.length > 4 ? ' …' : ''), 'Пароли, ключи и данные карт не должны возвращаться клиенту даже в хешированном виде.');
      const isAuthEndpoint = /login|auth|token|session|signin|oauth/i.test(url);
      if (tokens.length && !isAuthEndpoint) add('token-field', 'medium', 'API3', 'Токены в ответе не-авторизационного эндпоинта: ' + tokens.slice(0, 3).join(', '), 'Проверьте, что клиенту действительно нужен этот токен и что он не принадлежит другому пользователю.');
      const arr = Array.isArray(resp.json) ? resp.json : null;
      if (pii.size && arr && arr.length > 1) add('pii-list', 'medium', 'API3', 'Список из ' + arr.length + ' объектов с персональными данными: ' + Array.from(pii).join(', '), 'Excessive data exposure: возвращайте только поля, нужные экрану, и проверьте, что пользователь вправе видеть чужие данные.');
      if (arr && arr.length > 500) add('no-pagination', 'low', 'API4', 'Список без пагинации: ' + arr.length + ' элементов', 'Без лимитов один запрос может выгрузить всю таблицу и нагрузить сервер. Нужны limit/offset или курсор с максимальным размером страницы.');
    }
    const card = /\b(?:\d[ -]?){13,19}\b/g;
    let cm, cards = 0;
    while ((cm = card.exec(text)) && cards < 1) { const d = cm[0].replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && /^[3-6]/.test(d) && luhn(d)) cards++; }
    if (cards) add('card-number', 'high', 'API3', 'Похоже на номер банковской карты в ответе', 'Номера карт (PAN) нельзя отдавать целиком — маскируйте до последних 4 цифр.');
    if (/eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/.test(text) && !/login|auth|token|oauth/i.test(url)) add('jwt-in-body', 'low', 'API3', 'JWT в теле ответа', 'Убедитесь, что токен предназначен этому клиенту.');
    if (resp.size > 5 * 1024 * 1024) add('huge-response', 'low', 'API4', 'Очень большой ответ: ' + (resp.size / 1048576).toFixed(1) + ' МБ', 'Ограничьте размер выдачи.');

    // заголовки (только если браузер их показывает)
    if (headersVisible) {
      const https = /^https:/i.test(url);
      if (https && !hdr('strict-transport-security') && !isLocal(url)) add('no-hsts', 'low', 'API8', 'Нет Strict-Transport-Security', 'Без HSTS первый запрос клиента можно понизить до HTTP.');
      if (!hdr('x-content-type-options')) add('no-nosniff', 'low', 'API8', 'Нет X-Content-Type-Options: nosniff', 'Браузер может «угадать» тип содержимого и выполнить его как скрипт.');
      const server = hdr('server') || '', powered = hdr('x-powered-by') || '';
      if (/\d/.test(server) || powered) add('version-disclosure', 'low', 'API8', 'Раскрытие версии ПО: ' + [server, powered].filter(Boolean).join(', '), 'Версии помогают подобрать известные уязвимости. Уберите X-Powered-By и версию из Server.');
      const acao = hdr('access-control-allow-origin'), acac = hdr('access-control-allow-credentials');
      if (acao === '*' && reqHeader('Authorization')) add('cors-wildcard', 'medium', 'API8', 'CORS: Access-Control-Allow-Origin: * у эндпоинта с авторизацией', 'Любой сайт сможет читать ответ, если токен попадёт в браузер. Ограничьте список доверенных origin.');
      if (acao && acao !== '*' && acac === 'true' && /null/.test(acao)) add('cors-null', 'high', 'API8', 'CORS разрешает origin "null" с credentials', 'Origin null бывает у sandbox-iframe и file:// — атакующий может его получить.');
    }
    if (/html/.test(ct) && headersVisible && !hdr('content-security-policy')) add('no-csp', 'low', 'API8', 'HTML-ответ без Content-Security-Policy', 'API, отдающее HTML, уязвимо к XSS без CSP.');
    const cc = (hdr('cache-control') || '').toLowerCase();
    if (reqHeader('Authorization') && resp.code < 300 && resp.json !== undefined && !/no-store|private/.test(cc)) {
      add('cacheable-private', 'low', 'API8', 'Ответ с данными пользователя без Cache-Control: no-store/private', 'Общие кеши и прокси могут сохранить и отдать его другому пользователю.' + (cc ? ' Сейчас: ' + cc : ''));
    }

    // результаты генерированных кейсов безопасности
    const name = r.name || '';
    if (/без авторизации|неверный токен/.test(name) && resp.code >= 200 && resp.code < 300) add('no-auth', 'high', 'API2', 'Эндпоинт ответил ' + resp.code + ' без валидной авторизации', 'Кейс «' + name + '». Если данные не публичные — это обход аутентификации.');
    if (/IDOR: чужой id/.test(name) && resp.code >= 200 && resp.code < 300) add('idor', 'high', 'API1', 'Возможен IDOR: чужой объект вернулся с кодом ' + resp.code, 'Кейс «' + name + '». Проверьте вручную, принадлежит ли объект текущему пользователю.');
    if (/метод (DELETE|PUT|PATCH) вместо GET/.test(name) && resp.code >= 200 && resp.code < 300) add('method-tamper', 'high', 'API1', 'Эндпоинт принял неожиданный метод (' + req.method + ') с кодом ' + resp.code, 'Кейс «' + name + '». Проверьте, не изменились ли данные.');
    if (/токен в query/.test(name) && resp.code >= 200 && resp.code < 300) add('query-token-accepted', 'medium', 'API2', 'Сервер принимает токен из URL', 'Токены в URL утекают в логи. Принимайте их только из заголовка Authorization.');
    return out.map((f) => Object.assign(f, { headersVisible }));
  }

  /** Признаки по нагрузочному прогону: есть ли ограничение частоты запросов. */
  function scanLoad(load) {
    if (!load || !load.samples || load.samples.length < 50) return [];
    const has429 = Object.keys(load.statusCounts || {}).includes('429');
    if (has429) return [{ id: 'rate-limit-ok', sev: 'info', owasp: 'API4', title: 'Rate limit срабатывает (получены ответы 429)', detail: 'Хорошо: сервер ограничивает частоту запросов.' }];
    return [{ id: 'no-rate-limit', sev: 'medium', owasp: 'API4', title: 'Нет признаков rate limit: ' + load.samples.length + ' запросов за ' + load.elapsed.toFixed(1) + ' с без 429', detail: 'Если эндпоинт дорогой (поиск, логин, отправка SMS) — нужно ограничение частоты. Проверьте лимит на стенде с бóльшей нагрузкой.' }];
  }

  /** Сводный отчёт: группировка по находке, список затронутых запросов. */
  function scanAll(results, opts) {
    opts = opts || {};
    const byId = new Map();
    let hidden = 0, withResp = 0;
    results.forEach((r) => {
      const fs = scanResult(r);
      if (r.response) { withResp++; if (!hasVisibleHeaders(r)) hidden++; }
      fs.forEach((f) => {
        if (!byId.has(f.id)) byId.set(f.id, Object.assign({}, f, { affected: [] }));
        const e = byId.get(f.id);
        if (SEV_ORDER[f.sev] < SEV_ORDER[e.sev]) e.sev = f.sev;
        e.affected.push({ id: r.id, name: r.name, method: r.request && r.request.method, code: r.response ? r.response.code : null });
      });
    });
    scanLoad(opts.load).forEach((f) => byId.set(f.id, Object.assign({}, f, { affected: opts.load.name ? [{ name: opts.load.name }] : [] })));
    const findings = Array.from(byId.values()).sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.affected.length - a.affected.length);
    const counts = { high: 0, medium: 0, low: 0, info: 0 };
    findings.forEach((f) => counts[f.sev]++);
    return { findings, counts, scanned: withResp, headersHidden: withResp > 0 && hidden === withResp };
  }
  function hasVisibleHeaders(r) { return r.response && !r.response.mocked && r.response.headers.some(([k]) => !SAFELISTED.has(k.toLowerCase())); }

  Object.assign(ATA, { scanResult, scanLoad, scanAll, OWASP });
})(typeof window !== 'undefined' ? window : globalThis);
