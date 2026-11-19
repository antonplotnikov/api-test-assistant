// Тесты логики без браузера: node tests/core.test.js  (NETWORK=1 — ещё и запросы к jsonplaceholder)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
for (const f of ['schema.js', 'pm.js', 'core.js', 'gen.js']) vm.runInThisContext(fs.readFileSync(path.join(root, 'js', f), 'utf8'), { filename: f });
const ATA = globalThis.ATA;
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok  ' : '  FAIL') + ' ' + msg); if (!cond) fails++; };
const section = (s) => console.log('— ' + s);

(async () => {
  const coll = ATA.normalizeCollection(readJson('examples/sample.postman_collection.json'));
  const env = readJson('examples/sample.postman_environment.json');
  const spec = readJson('examples/jsonplaceholder.openapi.json');
  const targets = [];
  ATA.eachRequest(coll.item, (item, parents) => targets.push({ item, parents }));
  const byName = (n) => targets.find((t) => t.item.name === n);
  const scopes = () => ATA.makeScopes(coll, env.values);

  section('валидатор JSON Schema');
  const post = { id: 1, title: 't', body: 'b', userId: 1 };
  ok(ATA.validate({ $ref: '#/components/schemas/Post' }, post, { root: spec }).length === 0, 'валидный пост');
  const e1 = ATA.validate({ $ref: '#/components/schemas/Post' }, { id: '1', body: 'b', userId: 1, extra: 1 }, { root: spec, strict: true });
  ok(e1.some((e) => e.kind === 'missing') && e1.some((e) => e.kind === 'type') && e1.some((e) => e.kind === 'extra-warn'), 'нет поля, неверный тип, лишнее поле');
  ok(ATA.validate({ type: 'string', format: 'email' }, 'nope').length === 1, 'format email');
  ok(ATA.validate({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 1.5).length === 1, 'oneOf');
  ok(ATA.validate({ type: 'string', nullable: true }, null).length === 0, 'nullable (OpenAPI 3.0)');

  section('pm-песочница');
  const resp = { code: 404, status: 'Not Found', headers: [['content-type', 'application/json']], text: '{"a":{"b":2}}', json: { a: { b: 2 } }, timeMs: 50, size: 12 };
  const sc = scopes();
  const r = ATA.runScript([
    'pm.test("s", () => pm.response.to.have.status(200));',
    'pm.test("n", () => pm.expect(pm.response.json()).to.have.nested.property("a.b", 2));',
    'pm.test("oneOf", () => pm.expect(pm.response.code).to.be.oneOf([404, 410]));',
    'pm.test("not", () => pm.expect(1).to.not.equal(2));',
    'pm.test("hdr", () => pm.response.to.have.header("Content-Type"));',
    'pm.environment.set("x", 5); tests["legacy"] = responseCode.code === 404;',
    'pm.test("unsupported", () => pm.sendRequest("x"));',
  ].join('\n'), { response: resp, request: { method: 'GET', url: 'http://x', headers: [] }, scopes: sc });
  const by = Object.fromEntries(r.tests.map((t) => [t.name, t]));
  ok(!by.s.pass && /ожидался статус 200, получен 404/.test(by.s.message), 'status падает с понятным сообщением');
  ok(by.n.pass && by.oneOf.pass && by.not.pass && by.hdr.pass && by.legacy.pass, 'nested / oneOf / not / header / legacy tests[]');
  ok(!by.unsupported.pass && by.unsupported.unsupported, 'pm.sendRequest помечен как неподдерживаемый');
  ok(sc.env.get('x') === '5', 'pm.environment.set');

  section('сборка запроса');
  const created = byName('Создать пост');
  const b = ATA.buildRequest(coll, created.item, created.parents, ATA.scopeList(scopes()));
  ok(b.url === 'https://jsonplaceholder.typicode.com/posts', 'URL из окружения');
  ok(b.headers.some(([k, v]) => k === 'Authorization' && v === 'Bearer demo-token-not-secret'), 'bearer унаследован от коллекции');
  ok(b.headers.some(([k]) => k === 'Content-Type') && !/\{\{/.test(b.body), 'Content-Type и {{$timestamp}}');

  section('query и переменные');
  const q = ATA.splitQuery('{{baseUrl}}/comments?postId={{postId}}&sort=&x#top');
  ok(q.base === '{{baseUrl}}/comments' && q.params.length === 3 && q.params[0].value === '{{postId}}' && q.hash === '#top', 'splitQuery');
  q.params[1].disabled = true;
  ok(ATA.joinQuery(q.base, q.params, q.hash) === '{{baseUrl}}/comments?postId={{postId}}&x#top', 'joinQuery пропускает выключенные');
  const names = ATA.varNames(coll, created.item, created.parents);
  ok(names.includes('baseUrl') && names.includes('token') && names.includes('$timestamp'), 'varNames: URL, auth, тело — ' + names.join(','));

  section('моки и контракт (без сети)');
  const byId = byName('Пост по id');
  const mocks = [ATA.newMock({ method: 'GET', path: '/posts/:id', status: 200, body: '{"id": {{path.id}}, "body": "x", "userId": 1}' })];
  const mr = await ATA.runItem(coll, byId.item, byId.parents, scopes(), { mockMode: true, mocks, contract: spec });
  ok(mr.response && mr.response.mocked && mr.response.json.id === 1, 'мок ответил, :id подставлен');
  ok(mr.contract.issues.some((i) => i.kind === 'missing' && /title/.test(i.path)), 'контракт ловит отсутствующий title');
  ok(!mr.pass && ATA.analyze(mr).findings.some((f) => f.category === 'Контракт'), 'анализ: Контракт');
  const to = await ATA.runItem(coll, byId.item, byId.parents, scopes(), { mockMode: true, timeout: 100, mocks: [ATA.newMock({ path: '/posts/*', delay: 1000 })] });
  ok(to.error && to.error.kind === 'timeout' && ATA.analyze(to).category === 'Таймаут', 'таймаут через задержку мока');
  const r401 = await ATA.runItem(coll, byId.item, byId.parents, scopes(), { mockMode: true, mocks: [ATA.newMock({ path: '/posts/*', status: 401, body: '{"message":"token expired"}' })] });
  const a401 = ATA.analyze(r401);
  ok(a401.category === 'Авторизация' && /token expired/.test(a401.findings[0].why), 'анализ 401 цитирует сообщение сервера');

  section('snapshot-проверка');
  const snap = ATA.snapshotCode({ id: 7, title: 'a', tags: ['x'], meta: { at: 1 } }, 'id, at');
  const runSnap = (json) => ATA.runScript(snap, { response: { code: 200, status: 'OK', headers: [], text: JSON.stringify(json), json, timeMs: 1, size: 1 }, request: { method: 'GET', url: 'x', headers: [] }, scopes: scopes() }).tests[0];
  ok(runSnap({ id: 99, title: 'a', tags: ['x'], meta: { at: 5 } }).pass, 'игнорируемые поля не влияют');
  const sf = runSnap({ id: 7, title: 'b', tags: [], meta: { at: 1 }, extra: true });
  ok(!sf.pass && /\$\.title/.test(sf.message) && /элементов 0 вместо 1/.test(sf.message) && /новое поле/.test(sf.message), 'изменения найдены: ' + sf.message);
  let threw = false;
  try { ATA.snapshotCode(undefined); } catch (e) { threw = true; }
  ok(threw, 'без JSON-ответа — понятная ошибка');

  section('история и сравнение прогонов');
  const mk = (id, pass, ms, code) => ({ id, iteration: 0, name: id, pass, tests: [], request: { method: 'GET' }, response: { code: code || 200, timeMs: ms } });
  const prev = ATA.summarizeRun([mk('a', true, 100), mk('b', false, 100, 500), mk('c', true, 100), mk('gone', true, 10)]);
  const cur = ATA.summarizeRun([mk('a', false, 100, 404), mk('b', true, 100), mk('c', true, 400), mk('new', true, 10)]);
  const cmp = ATA.compareRuns(prev, cur);
  ok(cmp.newFail.length === 1 && cmp.byKey['a#0'] === 'regression', 'регрессия найдена');
  ok(cmp.fixed.length === 1 && cmp.byKey['b#0'] === 'fixed', 'починившийся найден');
  ok(cmp.slower.length === 1 && cmp.byKey['c#0'] === 'slower', 'замедление ×4 найдено');
  ok(cmp.added.length === 1 && cmp.removed.length === 1 && cmp.codeChanged.length === 2, 'новые / удалённые / сменившие код');

  section('отчёты');
  const results = [mr, to, r401];
  const xml = ATA.junitXml(results, 'Демо');
  ok(/^<\?xml/.test(xml) && /<testsuite name="Посты"/.test(xml) && (xml.match(/<failure /g) || []).length >= 3, 'JUnit XML');
  ok(!/[\u0000-\u0008]/.test(ATA.junitXml([Object.assign({}, mk('z', false, 1), { tests: [{ name: 'a\u0001b', pass: false, message: '<x>&' }] })])), 'JUnit XML экранирует спецсимволы');
  const html = ATA.htmlReport(results, { env: 'Демо', title: 'Отчёт' });
  ok(/<!doctype html>/.test(html) && /prefers-color-scheme:dark/.test(html) && /Пост по id/.test(html) && !/<script/i.test(html), 'HTML-отчёт: самодостаточный, без скриптов');

  section('генерация');
  const cases = ATA.generateCases(created.item, {});
  const groups = new Set(cases.map((c) => c._group));
  ok(cases.length > 20 && ['positive', 'auth', 'body', 'fields', 'boundary', 'robust'].every((g) => groups.has(g)), 'POST: ' + cases.length + ' кейсов, все группы');
  ok(ATA.generateCases(byId.item, {}).some((c) => /несуществующий id/.test(c.name)), 'кейсы по id в пути');
  let n = 0;
  ATA.eachRequest(ATA.collectionFromOpenApi(spec).item, () => n++);
  ok(n === 7 && ATA.mocksFromOpenApi(spec).length === 7, 'OpenAPI → 7 запросов и 7 моков');
  const back = ATA.fromCurl(ATA.toCurl(b));
  ok(back.request.method === 'POST' && back.request.url === b.url, 'cURL туда-обратно');
  ok(ATA.parseCsv('a,b\n1,"x,y"\n2,z\n').length === 2, 'CSV с кавычками');

  if (process.env.NETWORK) {
    section('реальная сеть (jsonplaceholder)');
    const envMap = scopes().env;
    const res = await ATA.runCollection(coll, targets, { envMap, contract: spec, timeout: 15000 });
    const bad = res.filter((x) => !x.pass).map((x) => x.name);
    ok(bad.length === 1 && bad[0] === 'Заведомо падающий: пост 0', 'падает только заведомо падающий');
    ok(envMap.get('createdPostId') === '101', 'переменная из POST сохранена');
  }

  console.log(fails ? '\n' + fails + ' ПРОВАЛОВ' : '\nвсё ок');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
