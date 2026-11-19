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
  };

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
    const groups = opts.groups || new Set(Object.keys(CASE_GROUPS));
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

  Object.assign(ATA, { ASSERTION_TYPES, inferSchema, analyze, bugReport, maskReq, CASE_GROUPS, generateCases, collectionFromOpenApi, newMock, mockFromResult, mocksFromOpenApi, FAILURE_PRESETS, collectionWithExamples, runReport, jsonBodyOf, setJsonBody });
})(typeof window !== 'undefined' ? window : globalThis);
