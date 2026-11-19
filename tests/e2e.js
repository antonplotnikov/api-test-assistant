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

(async () => {
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

  console.log('— сохранение и вёрстка');
  await page.reload({ waitUntil: 'networkidle0' });
  ok(/Список постов/.test(await page.$eval('#tree', (t) => t.innerText)), 'коллекция сохранилась после перезагрузки');
  ok((await page.evaluate(() => window.ATA_STATE.history.length)) === 3, 'история сохранилась после перезагрузки');
  const tokenVal = await page.evaluate(() => (window.ATA_STATE.envs.find((e) => e.name === 'Демо: JSONPlaceholder').values.find((v) => v.key === 'token') || {}).value);
  ok(tokenVal === '', 'секрет token не сохранён в браузере');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await sleep(300);
  for (const t of ['collection', 'runner', 'analysis', 'generate', 'load', 'contract', 'mocks']) {
    await tab(t);
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(o <= 0, 'мобильная вкладка ' + t + ' без горизонтальной прокрутки' + (o > 0 ? ' (+' + o + 'px)' : ''));
  }
  await tab('runner');
  await shot('3-mobile-runner');

  ok(errors.length === 0, 'ошибок JS нет' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  fs.rmSync(downloads, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' ПРОВАЛОВ' : '\nвсё ок');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
