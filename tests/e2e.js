// Браузерные тесты страницы. Нужен запущенный сервер (python3 -m http.server 8765) и Chrome.
//   BASE_URL=http://127.0.0.1:8765/ CHROME_PATH=/path/to/chrome node tests/e2e.js
// Тест ходит в сеть к jsonplaceholder.typicode.com.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const SHOTS = process.env.SHOTS_DIR || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL') + ' ' + m); if (!c) fails++; };

/* Локальный mock-сервер: имитирует Claude Messages API (SSE) и «второе окружение» для сравнения.
   Реальный API Anthropic в тестах не вызывается — деньги не тратятся. */
const http = require('http');
const MOCK_PORT = Number(process.env.MOCK_PORT || 8766);
const aiCalls = [];
function sse(res, text, model) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  const ev = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n');
  ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 900 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Смотрю на статус и проверки.' } });
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
  ev('content_block_stop', { index: 0 });
  ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < text.length; i += 40) ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: text.slice(i, i + 40) } });
  ev('content_block_stop', { index: 1 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } });
  ev('message_stop', {});
  res.end();
}
const mockServer = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET' && req.url.startsWith('/jp/users/1')) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    return res.end(JSON.stringify({ id: 1, name: 'Changed Name', username: 'Bret', email: 'Sincere@april.biz', address: { city: 'Gwenborough' } }));
  }
  if (req.method === 'GET' && req.url.startsWith('/jp/')) { res.writeHead(404, cors); return res.end('{}'); }
  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      aiCalls.push({ headers: req.headers, body, raw });
      if (body.output_config && body.output_config.format) {
        return sse(res, JSON.stringify({ title: 'Создание поста', cases: [
          { name: 'Создание поста с валидными данными', category: 'positive', priority: 'high', method: 'POST', path: '/posts', headers: [], body: '{"title":"Т","body":"Б","userId":1}', expected_status: [201], checks: 'pm.test("Есть id", function () { pm.expect(pm.response.json()).to.have.property("id"); });', rationale: 'Основной сценарий' },
          { name: 'Получение поста', category: 'positive', priority: 'medium', method: 'GET', path: '/posts/1', headers: [], body: '', expected_status: [200], checks: '', rationale: 'Чтение' },
        ] }), body.model);
      }
      sse(res, 'Вероятная причина — **неверное ожидание** в тесте.\n\n```javascript\npm.test("Статус 404 для несуществующего поста", function () {\n    pm.response.to.have.status(404);\n});\n```', body.model);
    });
    return;
  }
  res.writeHead(404, cors); res.end();
});

(async () => {
  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'ata-dl-'));
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-first-run'].concat(process.env.CI ? ['--no-sandbox'] : []) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const shot = (n) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, n + '.png') }) : null);
  const tab = (t) => page.click('#tabs button[data-tab=' + t + ']');
  const pickNode = (re) => page.evaluate((src) => { const n = Array.from(document.querySelectorAll('#tree .node')).find((x) => new RegExp(src).test(x.innerText.trim())); n.click(); }, re);
  const waitRun = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#runStatus').textContent), { timeout: 90000 }, re || 'Готово');

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE_URL, { waitUntil: 'networkidle0' });

  console.log('— импорт и одиночный запрос');
  ok(await page.$eval('#importDlg', (d) => d.open), 'диалог импорта открыт при пустой коллекции');
  await page.click('#importDemo');
  await page.waitForFunction(() => /Список постов/.test(document.querySelector('#tree').innerText), { timeout: 10000 });
  ok(true, 'демо-коллекция загружена');
  ok((await page.$eval('#envSelect', (s) => s.options[s.selectedIndex].text)) === 'Демо: JSONPlaceholder', 'окружение выбрано');
  await pickNode('^GET\\s*Пост по id');
  const vars = await page.$eval('.varline', (e) => e.innerText);
  ok(/✓ baseUrl/.test(vars) && /✓ postId/.test(vars) && /✓ token/.test(vars), 'строка переменных: ' + vars.replace(/\s+/g, ' '));
  await page.click('#sendBtn');
  await page.waitForFunction(() => /проверки \d+\/\d+/.test(document.querySelector('#responsePanel').innerText), { timeout: 20000 });
  ok(/проверки 4\/4/.test(await page.$eval('#responsePanel', (p) => p.innerText)), 'одиночный запрос: 4/4 проверки');

  console.log('— snapshot-проверка');
  await page.evaluate(() => Array.from(document.querySelectorAll('#editor .sub-tabs button')).find((b) => /Проверки/.test(b.textContent)).click());
  await page.evaluate(() => { const sel = document.querySelector('#editor select:not([aria-label])'); });
  await page.evaluate(() => { const s = Array.from(document.querySelectorAll('#editor select')).find((x) => Array.from(x.options).some((o) => o.value === 'snapshot')); s.value = 'snapshot'; s.dispatchEvent(new Event('change')); s.nextElementSibling.value = 'id'; });
  await page.evaluate(() => Array.from(document.querySelectorAll('#editor button')).find((b) => /Добавить проверку/.test(b.textContent)).click());
  const testsCode = await page.evaluate(() => window.ATA.scriptOf(window.ATA.findById(window.ATA_STATE.coll, window.ATA_STATE.selectedId).item, 'test'));
  ok(/Ответ совпадает с эталоном/.test(testsCode) && /var ignore = \["id"\]/.test(testsCode), 'эталон добавлен в Tests');
  await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await page.waitForFunction(() => /проверки 5\/5/.test(document.querySelector('#responsePanel').innerText), { timeout: 20000 });
  ok(true, '⌘/Ctrl+Enter отправил запрос, эталон совпал (5/5)');

  console.log('— Params');
  await pickNode('Комментарии к посту');
  await page.evaluate(() => Array.from(document.querySelectorAll('#editor .sub-tabs button')).find((b) => /Params/.test(b.textContent)).click());
  const pkeys = await page.$$eval('#editor .kv input[aria-label="Ключ"]', (xs) => xs.map((x) => x.value));
  ok(pkeys.length === 1 && pkeys[0] === 'postId', 'параметр postId разобран из URL');
  await page.evaluate(() => Array.from(document.querySelectorAll('#editor .kv button')).find((b) => /добавить/.test(b.textContent)).click());
  const inputs = await page.$$('#editor .kv input[type=text]');
  await inputs[inputs.length - 2].type('_limit');
  await inputs[inputs.length - 1].type('2');
  const url = await page.$eval('#editor input[aria-label=URL]', (i) => i.value);
  ok(url === '{{baseUrl}}/comments?postId={{postId}}&_limit=2', 'URL обновился из Params: ' + url);
  await shot('1-collection');

  console.log('— JSON-дерево: проверка по клику');
  await pickNode('^GET\\s*Пост по id');
  await page.waitForSelector('#responsePanel .jtree');
  await page.evaluate(() => Array.from(document.querySelectorAll('#responsePanel .jtree .jv')).find((b) => /sunt aut facere/.test(b.textContent)).click());
  await page.waitForSelector('.popmenu');
  const menuText = await page.$eval('.popmenu', (m) => m.innerText);
  ok(/\$\.title/.test(menuText) && /Тип: string/.test(menuText) && /Сохранить в переменную/.test(menuText), 'меню для поля $.title');
  await page.evaluate(() => Array.from(document.querySelectorAll('.popmenu button')).find((b) => /^=/.test(b.textContent)).click());
  const treeTests = await page.evaluate(() => window.ATA.scriptOf(window.ATA.findById(window.ATA_STATE.coll, window.ATA_STATE.selectedId).item, 'test'));
  ok(/pm\.expect\(pm\.response\.json\(\)\.title\)\.to\.eql\("sunt aut facere/.test(treeTests), 'проверка значения добавлена в Tests');
  await page.click('#sendBtn');
  await page.waitForFunction(() => /проверки 6\/6/.test(document.querySelector('#responsePanel').innerText), { timeout: 20000 }).then(() => ok(true, 'новая проверка проходит (6/6)'), () => ok(false, 'новая проверка проходит (6/6)'));

  console.log('— прогон, история, сравнение');
  await tab('runner');
  await page.click('#runBtn');
  await waitRun();
  const rows = await page.$$eval('#runTable tr.click', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  ok(rows.length === 8, 'в таблице 8 запросов: ' + rows.length + (rows.length !== 8 ? ' → ' + rows.join(' | ') : ''));
  const failedRows = rows.filter((r) => /FAIL/.test(r));
  ok(failedRows.length === 1 && /пост 0/.test(failedRows[0]), 'упал только «пост 0»');
  ok((await page.$$eval('#historyPanel tr', (r) => r.length)) === 2, 'в истории 1 прогон');
  // включаем сбой 500 для «Пост по id» — во втором прогоне это регрессия
  await tab('mocks');
  await page.evaluate(() => { const s = document.querySelector('#failTarget'); s.value = Array.from(s.options).find((o) => /Пост по id/.test(o.text)).value; Array.from(document.querySelectorAll('#failPresets button')).find((b) => /500/.test(b.textContent)).click(); });
  ok(/ВКЛ/.test(await page.$eval('#mockToggle', (b) => b.textContent)), 'моки включились');
  await tab('runner');
  await page.click('#runBtn');
  await waitRun();
  const cmp = await page.$eval('#runCompare', (e) => e.innerText);
  ok(/1 новых падений/.test(cmp) && /Пост по id/.test(cmp), 'сравнение: регрессия «Пост по id»');
  ok(/регрессия/.test(await page.$eval('#runTable', (t) => t.innerText)), 'в таблице колонка Δ с «регрессия»');
  await shot('2-runner');
  // выключаем моки и перезапускаем упавшие
  await page.click('#mockToggle');
  await page.click('#rerunFailed');
  await waitRun();
  const rerunRows = await page.$$eval('#runTable tr.click', (r) => r.length);
  ok(rerunRows === 2, 'перезапущены только 2 упавших: ' + rerunRows);
  ok(/1 починилось/.test(await page.$eval('#runCompare', (e) => e.innerText)), 'после перезапуска: 1 починилось');
  ok((await page.$$eval('#historyPanel tr', (r) => r.length)) === 4, 'в истории 3 прогона');

  console.log('— отчёты');
  await page.click('#htmlReportBtn');
  await page.click('#junitBtn');
  await sleep(1500);
  const files = fs.readdirSync(downloads);
  const htmlF = files.find((f) => f.endsWith('.html')), xmlF = files.find((f) => f.endsWith('.xml'));
  ok(htmlF && /Отчёт: Демо/.test(fs.readFileSync(path.join(downloads, htmlF), 'utf8')), 'HTML-отчёт скачан');
  ok(xmlF && /<testsuites/.test(fs.readFileSync(path.join(downloads, xmlF), 'utf8')), 'JUnit XML скачан');

  console.log('— анализ, контракт, генерация, нагрузка');
  await tab('analysis');
  ok(/404 Not Found/.test(await page.$eval('#analysisList', (e) => e.innerText)), 'анализ: 404 разобран');
  await tab('contract');
  ok(/7 \/ 7|\d \/ 7/.test(await page.$eval('#contractResult', (e) => e.innerText)), 'контракт: покрытие операций');
  await tab('generate');
  await page.evaluate(() => { const s = document.querySelector('#genSource'); s.value = Array.from(s.options).find((o) => /Создать пост/.test(o.text)).value; });
  await page.click('#genBtn');
  const nCases = await page.$$eval('#genPreview input[data-i]', (x) => x.length);
  ok(nCases > 20, 'сгенерировано кейсов: ' + nCases);
  await tab('load');
  await page.evaluate(() => { const s = document.querySelector('#loadSource'); s.value = Array.from(s.options).find((o) => /Пост по id/.test(o.text)).value; document.querySelector('#loadTotal').value = 30; });
  await page.click('#loadBtn');
  await page.waitForFunction(() => /Готово/.test(document.querySelector('#loadStatus').textContent), { timeout: 60000 });
  ok((await page.$$eval('#loadScatter circle', (x) => x.length)) === 30, 'нагрузка: 30 точек на графике');

  console.log('— перетаскивание файла');
  await tab('collection');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["curl -X POST 'https://jsonplaceholder.typicode.com/posts' -H 'Content-Type: application/json' --data-raw '{\"title\":\"dnd\"}'"], 'request.txt', { type: 'text/plain' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => /POST\s*\/posts/.test(document.querySelector('#tree').innerText), { timeout: 5000 }).then(() => ok(true, 'cURL из перетащенного файла стал запросом'), () => ok(false, 'cURL из перетащенного файла стал запросом'));

  console.log('— поток переменных и экспорт в код');
  await tab('collection');
  await page.click('#varTabs button[data-v=flow]');
  const flowText = await page.$eval('#varEditor', (e) => e.innerText);
  ok(/\{\{createdPostId\}\}/.test(flowText) && /Ставится, но нигде не используется/.test(flowText) && /\{\{baseUrl\}\}/.test(flowText), 'поток: createdPostId ставится, но не используется' + (/Ставится, но нигде/.test(flowText) ? '' : ' → ' + flowText.slice(0, 500).replace(/\s+/g, ' ')));
  await page.click('#varTabs button[data-v=env]');
  await page.click('#exportBtn');
  await page.select('#codeFormat', 'pytest');
  await page.click('#codePreview');
  const py = await page.$eval('#codeOut', (e) => e.textContent);
  ok(/def test_001_/.test(py) && /assert r\.status_code == 200/.test(py) && /os\.environ\.get\("TOKEN", ""\)/.test(py), 'экспорт pytest: тесты и секрет из окружения');
  ok(/проверок переведено: \d+/.test(await page.$eval('#codeStats', (e) => e.textContent)), 'статистика перевода показана');
  await page.select('#codeFormat', 'playwright');
  await page.click('#codeDownload');
  await page.click('#exportClose');
  await tab('load');
  await page.click('#loadK6');
  await sleep(1200);
  const dl = fs.readdirSync(downloads);
  ok(dl.includes('api.spec.ts') && /test\.describe\.serial/.test(fs.readFileSync(path.join(downloads, 'api.spec.ts'), 'utf8')), 'Playwright-файл скачан');
  const k6f = dl.find((f) => /^load-.*\.js$/.test(f));
  ok(k6f && /export const options/.test(fs.readFileSync(path.join(downloads, k6f), 'utf8')), 'k6-сценарий скачан с вкладки «Нагрузка»');

  console.log('— сканер безопасности');
  await tab('mocks');
  await page.evaluate(() => {
    const S = window.ATA_STATE;
    S.mocks.unshift(window.ATA.newMock({ name: 'утечка', method: 'GET', path: '/users/1', status: 200, headers: '{"Content-Type":"application/json","Server":"nginx/1.18.0"}', body: '[{"id":1,"email":"a@x.io","password":"hash1"},{"id":2,"email":"b@x.io","password":"hash2"}]' }));
    S.mockMode = true;
    window.ATA_APP.renderMockToggle();
  });
  await tab('collection');
  await pickNode('^GET\\s*Пользователь по id');
  await page.click('#sendBtn');
  await page.waitForFunction(() => /мок:/.test(document.querySelector('#responsePanel').innerText), { timeout: 10000 });
  await tab('security');
  const secText = await page.$eval('#secList', (e) => e.innerText);
  ok(/секретные поля/.test(secText) && /персональными данными/.test(secText), 'сканер: пароли и PII в ответе');
  ok(!/Раскрытие версии ПО|Strict-Transport-Security/.test(secText), 'заголовки мока не проверяются (это не реальный сервер)');
  ok(Number(await page.$eval('#secCount', (e) => e.textContent)) >= 1, 'бейдж высокого риска на вкладке');
  await shot('4-security');
  await page.evaluate(() => { const S = window.ATA_STATE; S.mocks.shift(); S.mockMode = false; window.ATA_APP.renderMockToggle(); });

  console.log('— сравнение окружений');
  await page.evaluate((port) => {
    const S = window.ATA_STATE;
    S.envs.push({ name: 'Stage (mock)', values: [{ key: 'baseUrl', value: 'http://127.0.0.1:' + port + '/jp', type: 'default', enabled: true }, { key: 'token', value: 'stage-token-not-secret', type: 'secret', enabled: true }] });
  }, MOCK_PORT);
  await tab('runner');
  await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('#cmpScope option')).find((o) => /Пользователи/.test(o.text));
    document.querySelector('#cmpScope').value = opt.value;
    const S = window.ATA_STATE;
    document.querySelector('#cmpEnvA').value = String(S.envs.findIndex((e) => e.name === 'Демо: JSONPlaceholder'));
    document.querySelector('#cmpEnvB').value = String(S.envs.findIndex((e) => e.name === 'Stage (mock)'));
  });
  await page.click('#cmpBtn');
  await page.waitForFunction(() => /Готово/.test(document.querySelector('#cmpStatus').textContent), { timeout: 30000 });
  const cmpText = await page.$eval('#cmpResult', (e) => e.innerText);
  ok(/отличий: \d+/.test(cmpText) && /разный статус/.test(cmpText), 'сравнение: тело отличается у пользователя, статус — у комментариев');
  await page.evaluate(() => Array.from(document.querySelectorAll('#cmpResult tr.click')).find((r) => /Пользователь по id/.test(r.innerText)).click());
  const diffText = await page.$eval('#cmpResult', (e) => e.innerText);
  ok(/\$\.name/.test(diffText) && /Changed Name/.test(diffText) && /\$\.phone/.test(diffText), 'детали: $.name изменилось, $.phone пропало');
  await shot('5-env-compare');

  console.log('— ИИ-ассистент (mock Claude API)');
  await tab('collection');
  await pickNode('^GET\\s*Заведомо падающий');
  await page.click('#sendBtn');
  await page.waitForFunction(() => /проверки \d+\/\d+/.test(document.querySelector('#responsePanel').innerText), { timeout: 20000 });
  await tab('ai');
  await page.type('#aiKey', 'sk-ant-test-key-123');
  await page.evaluate((port) => { const i = document.querySelector('#aiBaseUrl'); i.value = 'http://127.0.0.1:' + port; i.dispatchEvent(new Event('input')); }, MOCK_PORT);
  await page.evaluate(() => Array.from(document.querySelectorAll('#aiActions button')).find((b) => /Почему упал/.test(b.textContent)).click());
  await page.waitForFunction(() => /вход \d+ ток/.test(document.querySelector('#aiChat').innerText), { timeout: 30000 }).catch(() => {});
  const chat = await page.$eval('#aiChat', (e) => e.innerText);
  ok(/неверное ожидание/.test(chat) && /вход 1020 ток\. \(из кеша 900\), ответ 42/.test(chat), 'ответ ассистента отрисован, токены посчитаны: ' + chat.slice(-120).replace(/\s+/g, ' '));
  ok(/Ход рассуждений/.test(chat), 'сводка рассуждений показана');
  const call = aiCalls[0] || { headers: {}, body: {}, raw: '' };
  // SDK 1.x (API 2026-10-21) передаёт ключ как Authorization: Bearer
  ok(call.headers['authorization'] === 'Bearer sk-ant-test-key-123' && call.headers['anthropic-dangerous-direct-browser-access'] === 'true' && call.headers['anthropic-version'] === '2026-10-21', 'SDK: ключ в Authorization, заголовок прямого доступа из браузера, версия API');
  ok(call.body.model === 'claude-opus-5-5' && call.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(call.headers['anthropic-beta'] || '') && call.body.stream === true, 'модель Opus 5.5, fallbacks: default, стриминг');
  ok(call.body.output_config && call.body.output_config.effort === 'medium' && call.body.thinking && call.body.thinking.type === 'adaptive', 'effort и adaptive thinking');
  ok(/<request_context>/.test(call.raw) && /posts\/0/.test(call.raw) && !/demo-token-not-secret|stage-token-not-secret|sk-ant-test-key-123/.test(JSON.stringify(call.body.messages)), 'контекст приложен, секреты и ключ замаскированы');
  // кнопка «Добавить в Tests»
  const addBtn = await page.evaluateHandle(() => Array.from(document.querySelectorAll('#aiChat .md-code button')).find((b) => /Добавить в Tests/.test(b.textContent)));
  ok(!!(await addBtn.evaluate((b) => !!b)), 'у блока кода есть «Добавить в Tests»');
  await addBtn.evaluate((b) => b.click());
  const testsAfter = await page.evaluate(() => window.ATA.scriptOf(window.ATA.findById(window.ATA_STATE.coll, window.ATA_STATE.selectedId).item, 'test'));
  ok(/от ИИ-ассистента/.test(testsAfter) && /Статус 404 для несуществующего поста/.test(testsAfter), 'код от ИИ добавлен в Tests запроса');
  // второй вопрос: контекст не дублируется, история передаётся
  await page.type('#aiInput', 'А что ещё проверить?');
  await page.click('#aiSend');
  await page.waitForFunction((n) => document.querySelectorAll('#aiChat .msg.assistant').length >= 2 && !document.querySelector('#aiChat .typing'), { timeout: 30000 });
  const call2 = aiCalls[1] || { body: { messages: [] } };
  ok(call2.body.messages.length === 3 && call2.body.messages[1].role === 'assistant' && call2.body.messages[1].content.some((b) => b.type === 'thinking'), 'история диалога с thinking-блоками передана обратно');
  // кейсы из требований (structured outputs)
  await page.type('#aiReq', 'Пользователь может создать пост. Заголовок обязателен, автор — текущий пользователь.');
  await page.click('#aiReqBtn');
  await page.waitForFunction(() => /Готово: \d+ кейсов/.test(document.querySelector('#aiReqInfo').textContent), { timeout: 30000 }).catch(() => {});
  const call3 = aiCalls[2] || { body: {} };
  ok(call3.body.output_config && call3.body.output_config.format && call3.body.output_config.format.type === 'json_schema', 'кейсы запрошены через structured outputs (json_schema)');
  ok((await page.$$eval('#aiReqResult input[data-i]', (x) => x.length)) === 2, 'превью: 2 кейса');
  await shot('6-ai');
  await page.evaluate(() => Array.from(document.querySelectorAll('#aiReqResult button')).find((b) => /Добавить в коллекцию/.test(b.textContent)).click());
  ok(/ИИ: Создание поста/.test(await page.$eval('#tree', (t) => t.innerText)), 'кейсы ИИ добавлены папкой в коллекцию');
  const aiCase = await page.evaluate(() => { let it; window.ATA.eachRequest(window.ATA_STATE.coll.item, (x) => { if (/с валидными данными/.test(x.name)) it = x; }); return { url: it.request.url, tests: window.ATA.scriptOf(it, 'test') }; });
  ok(aiCase.url === '{{baseUrl}}/posts' && /have\.status\(201\)/.test(aiCase.tests) && /Есть id/.test(aiCase.tests), 'кейс ИИ: URL от {{baseUrl}}, проверка статуса и тела');

  console.log('— сохранение и вёрстка');
  await page.reload({ waitUntil: 'networkidle0' });
  ok(/Список постов/.test(await page.$eval('#tree', (t) => t.innerText)), 'коллекция сохранилась после перезагрузки');
  ok((await page.evaluate(() => window.ATA_STATE.history.length)) === 3, 'история сохранилась после перезагрузки');
  const tokenVal = await page.evaluate(() => (window.ATA_STATE.envs.find((e) => e.name === 'Демо: JSONPlaceholder').values.find((v) => v.key === 'token') || {}).value);
  ok(tokenVal === '', 'секрет token не сохранён в браузере');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await sleep(300);
  for (const t of ['collection', 'runner', 'analysis', 'generate', 'load', 'contract', 'mocks', 'security', 'ai']) {
    await tab(t);
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(o <= 0, 'мобильная вкладка ' + t + ' без горизонтальной прокрутки' + (o > 0 ? ' (+' + o + 'px)' : ''));
  }
  await tab('runner');
  await shot('3-mobile-runner');

  ok(errors.length === 0, 'ошибок JS нет' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  mockServer.close();
  fs.rmSync(downloads, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' ПРОВАЛОВ' : '\nвсё ок');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
