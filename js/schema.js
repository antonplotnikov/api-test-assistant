/* Валидатор JSON Schema (подмножество draft-04..2020 + OpenAPI 3 nullable) и помощники OpenAPI. */
(function (G) {
  'use strict';
  const ATA = (G.ATA = G.ATA || {});

  const FORMATS = {
    'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
    date: /^\d{4}-\d{2}-\d{2}$/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    uri: /^[a-z][a-z0-9+.-]*:\S+$/i,
    ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
  };

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
  }

  function typeMatches(t, v) {
    const a = typeOf(v);
    if (t === 'number') return a === 'number' || a === 'integer';
    return t === a;
  }

  function resolveRef(ref, root) {
    if (typeof ref !== 'string' || !ref.startsWith('#')) throw new Error('Внешние $ref не поддерживаются: ' + ref);
    const parts = ref.slice(1).split('/').filter(Boolean).map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
    let cur = root;
    for (const p of parts) {
      if (cur == null || !(p in cur)) throw new Error('Не найден $ref: ' + ref);
      cur = cur[p];
    }
    return cur;
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }

  function fmtPath(path, key) {
    return typeof key === 'number' ? path + '[' + key + ']' : /^[A-Za-z_$][\w$]*$/.test(key) ? path + '.' + key : path + '[' + JSON.stringify(key) + ']';
  }

  function short(v) {
    let s;
    try { s = JSON.stringify(v); } catch (e) { s = String(v); }
    if (s === undefined) s = String(v);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  }

  /**
   * validate(schema, data, opts) → [{path, message, kind}]
   * opts.root — корень для $ref; opts.strict — сообщать о необъявленных полях.
   */
  function validate(schema, data, opts) {
    opts = opts || {};
    const root = opts.root || schema;
    const errors = [];
    walk(schema, data, '$', 0);
    return errors;

    function err(path, message, kind) { errors.push({ path, message, kind: kind || 'error' }); }

    function walk(s, v, path, depth) {
      if (depth > 60) return;
      if (s === true || s == null) return;
      if (s === false) return err(path, 'значение запрещено схемой');
      if (s.$ref) {
        let target;
        try { target = resolveRef(s.$ref, root); } catch (e) { return err(path, e.message); }
        return walk(target, v, path, depth + 1);
      }
      if (v === null && (s.nullable === true || s['x-nullable'] === true)) return;

      if (s.type !== undefined) {
        const types = Array.isArray(s.type) ? s.type : [s.type];
        if (!types.some((t) => typeMatches(t, v))) {
          return err(path, 'ожидался тип ' + types.join('|') + ', получен ' + typeOf(v) + ' (' + short(v) + ')', 'type');
        }
      }
      if (s.enum && !s.enum.some((e) => deepEqual(e, v))) err(path, 'значение ' + short(v) + ' не из списка ' + short(s.enum), 'enum');
      if ('const' in s && !deepEqual(s.const, v)) err(path, 'ожидалось ' + short(s.const) + ', получено ' + short(v), 'enum');

      const t = typeOf(v);
      if (t === 'string') {
        if (s.minLength != null && v.length < s.minLength) err(path, 'длина ' + v.length + ' < minLength ' + s.minLength);
        if (s.maxLength != null && v.length > s.maxLength) err(path, 'длина ' + v.length + ' > maxLength ' + s.maxLength);
        if (s.pattern) {
          try { if (!new RegExp(s.pattern, 'u').test(v)) err(path, 'не соответствует pattern ' + s.pattern); } catch (e) { /* некорректный pattern игнорируем */ }
        }
        if (s.format && FORMATS[s.format] && !FORMATS[s.format].test(v)) err(path, 'не соответствует format ' + s.format + ': ' + short(v), 'format');
      }
      if (t === 'number' || t === 'integer') {
        if (s.minimum != null && (s.exclusiveMinimum === true ? v <= s.minimum : v < s.minimum)) err(path, v + ' меньше minimum ' + s.minimum);
        if (s.maximum != null && (s.exclusiveMaximum === true ? v >= s.maximum : v > s.maximum)) err(path, v + ' больше maximum ' + s.maximum);
        if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) err(path, v + ' ≤ exclusiveMinimum ' + s.exclusiveMinimum);
        if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) err(path, v + ' ≥ exclusiveMaximum ' + s.exclusiveMaximum);
        if (s.multipleOf && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) err(path, v + ' не кратно ' + s.multipleOf);
      }
      if (t === 'array') {
        if (s.minItems != null && v.length < s.minItems) err(path, 'элементов ' + v.length + ' < minItems ' + s.minItems);
        if (s.maxItems != null && v.length > s.maxItems) err(path, 'элементов ' + v.length + ' > maxItems ' + s.maxItems);
        if (s.uniqueItems) {
          for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if (deepEqual(v[i], v[j])) { err(path, 'элементы не уникальны (' + i + ' и ' + j + ')'); i = v.length; break; }
        }
        if (Array.isArray(s.prefixItems)) s.prefixItems.forEach((ps, i) => i < v.length && walk(ps, v[i], fmtPath(path, i), depth + 1));
        if (Array.isArray(s.items)) s.items.forEach((ps, i) => i < v.length && walk(ps, v[i], fmtPath(path, i), depth + 1));
        else if (s.items) {
          const start = Array.isArray(s.prefixItems) ? s.prefixItems.length : 0;
          // ограничиваем количество проверяемых элементов, чтобы большие ответы не тормозили страницу
          const max = Math.min(v.length, 500);
          for (let i = start; i < max; i++) walk(s.items, v[i], fmtPath(path, i), depth + 1);
        }
      }
      if (t === 'object') {
        const props = s.properties || {};
        (s.required || []).forEach((k) => { if (!(k in v)) err(fmtPath(path, k), 'отсутствует обязательное поле', 'missing'); });
        if (s.minProperties != null && Object.keys(v).length < s.minProperties) err(path, 'полей меньше minProperties ' + s.minProperties);
        if (s.maxProperties != null && Object.keys(v).length > s.maxProperties) err(path, 'полей больше maxProperties ' + s.maxProperties);
        for (const k of Object.keys(v)) {
          if (k in props) { walk(props[k], v[k], fmtPath(path, k), depth + 1); continue; }
          let matchedPattern = false;
          if (s.patternProperties) {
            for (const [re, ps] of Object.entries(s.patternProperties)) {
              try { if (new RegExp(re, 'u').test(k)) { matchedPattern = true; walk(ps, v[k], fmtPath(path, k), depth + 1); } } catch (e) { /* skip */ }
            }
          }
          if (matchedPattern) continue;
          if (s.additionalProperties === false) err(fmtPath(path, k), 'лишнее поле (additionalProperties: false)', 'extra');
          else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, v[k], fmtPath(path, k), depth + 1);
          else if (opts.strict && s.properties && !s.allOf && !s.anyOf && !s.oneOf) err(fmtPath(path, k), 'поле не описано в схеме (строгий режим)', 'extra-warn');
        }
      }

      if (Array.isArray(s.allOf)) {
        // для allOf в строгом режиме свойства объединяются, чтобы не ловить ложные «лишние поля»
        if (opts.strict && t === 'object') {
          const merged = mergeAllOf(s, root);
          const sub = validate(merged, v, { root, strict: true });
          sub.forEach((e) => errors.push({ path: path + e.path.slice(1), message: e.message, kind: e.kind }));
        } else s.allOf.forEach((sub) => walk(sub, v, path, depth + 1));
      }
      if (Array.isArray(s.anyOf)) {
        const ok = s.anyOf.some((sub) => validate(sub, v, { root }).length === 0);
        if (!ok) err(path, 'не подходит ни под один вариант anyOf', 'type');
      }
      if (Array.isArray(s.oneOf)) {
        const n = s.oneOf.filter((sub) => validate(sub, v, { root }).length === 0).length;
        if (n !== 1) err(path, n === 0 ? 'не подходит ни под один вариант oneOf' : 'подходит под ' + n + ' вариантов oneOf (нужен ровно 1)', 'type');
      }
      if (s.not && validate(s.not, v, { root }).length === 0) err(path, 'значение подходит под запрещённую схему (not)');
    }
  }

  function mergeAllOf(s, root) {
    const out = { type: 'object', properties: {}, required: [] };
    const visit = (x, d) => {
      if (!x || d > 20) return;
      if (x.$ref) return visit(resolveRef(x.$ref, root), d + 1);
      if (x.properties) Object.assign(out.properties, x.properties);
      if (x.required) out.required.push(...x.required);
      if (x.allOf) x.allOf.forEach((y) => visit(y, d + 1));
    };
    visit(s, 0);
    return out;
  }

  /* ---------- OpenAPI ---------- */

  function isOpenApi(doc) { return !!(doc && typeof doc === 'object' && (doc.openapi || doc.swagger) && doc.paths); }

  /** Список операций: [{method, path, op, regex, params}] */
  function listOperations(spec) {
    const out = [];
    const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    for (const [p, item] of Object.entries(spec.paths || {})) {
      for (const m of methods) {
        if (!item[m]) continue;
        const names = [];
        const re = new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '{' || c === '}' ? c : '\\' + c)).replace(/\{([^}]+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
        out.push({ method: m.toUpperCase(), path: p, op: item[m], pathItem: item, regex: re, paramNames: names, key: m.toUpperCase() + ' ' + p });
      }
    }
    // более конкретные пути (меньше параметров) проверяем раньше
    out.sort((a, b) => a.paramNames.length - b.paramNames.length || b.path.length - a.path.length);
    return out;
  }

  function serverBasePaths(spec) {
    const bases = [];
    if (spec.servers) spec.servers.forEach((s) => { try { bases.push(new URL(s.url, 'http://x').pathname.replace(/\/$/, '')); } catch (e) { /* skip */ } });
    if (spec.basePath) bases.push(spec.basePath.replace(/\/$/, ''));
    bases.push('');
    return bases;
  }

  function findOperation(spec, method, url) {
    let pathname;
    try { pathname = new URL(url).pathname; } catch (e) { pathname = String(url).split('?')[0]; }
    pathname = decodeURI(pathname);
    const ops = listOperations(spec);
    for (const base of serverBasePaths(spec)) {
      if (base && !pathname.startsWith(base)) continue;
      const rest = pathname.slice(base.length) || '/';
      for (const o of ops) if (o.method === method.toUpperCase() && o.regex.test(rest)) return o;
    }
    return null;
  }

  /** Схема ответа для кода статуса (точный → 2XX → default). */
  function responseSchema(spec, op, status) {
    const responses = op.op.responses || {};
    const key = responses[String(status)] ? String(status) : responses[String(status)[0] + 'XX'] ? String(status)[0] + 'XX' : responses.default ? 'default' : null;
    if (!key) return { documented: false, codes: Object.keys(responses) };
    let r = responses[key];
    if (r && r.$ref) r = resolveRef(r.$ref, spec);
    if (r.schema) return { documented: true, key, schema: r.schema }; // Swagger 2.0
    const content = r.content || {};
    const ct = Object.keys(content).find((c) => /json/i.test(c));
    return { documented: true, key, schema: ct ? content[ct].schema : null, example: ct ? content[ct].example : undefined };
  }

  /** Проверка одного ответа против спецификации → {op, issues:[{path,message,kind}]} */
  function checkContract(spec, method, url, status, json, strict) {
    const op = findOperation(spec, method, url);
    if (!op) return { op: null, issues: [{ path: '', message: 'операция ' + method + ' ' + url + ' не описана в спецификации', kind: 'undocumented' }] };
    const rs = responseSchema(spec, op, status);
    if (!rs.documented) return { op, issues: [{ path: '', message: 'код ' + status + ' не задокументирован (есть: ' + rs.codes.join(', ') + ')', kind: 'status' }] };
    if (!rs.schema) return { op, issues: [] };
    if (json === undefined) return { op, issues: [{ path: '$', message: 'ожидался JSON-ответ, тело не JSON', kind: 'type' }] };
    return { op, issues: validate(rs.schema, json, { root: spec, strict }) };
  }

  /** Пример значения по схеме (для генерации запросов и моков). */
  function sampleFromSchema(s, root, depth) {
    depth = depth || 0;
    if (!s || depth > 8) return null;
    if (s.$ref) { try { return sampleFromSchema(resolveRef(s.$ref, root), root, depth + 1); } catch (e) { return null; } }
    if (s.example !== undefined) return s.example;
    if (s.examples && Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    if (s.default !== undefined) return s.default;
    if (s.const !== undefined) return s.const;
    if (s.enum) return s.enum[0];
    if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => sampleFromSchema(x, root, depth + 1)).filter((x) => x && typeof x === 'object'));
    if (s.oneOf || s.anyOf) return sampleFromSchema((s.oneOf || s.anyOf)[0], root, depth + 1);
    const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type || (s.properties ? 'object' : s.items ? 'array' : 'string');
    switch (type) {
      case 'object': {
        const o = {};
        for (const [k, ps] of Object.entries(s.properties || {})) o[k] = sampleFromSchema(ps, root, depth + 1);
        return o;
      }
      case 'array': return s.items ? [sampleFromSchema(s.items, root, depth + 1)] : [];
      case 'integer': return s.minimum != null ? Math.ceil(s.minimum) : 1;
      case 'number': return s.minimum != null ? s.minimum : 1.5;
      case 'boolean': return true;
      case 'null': return null;
      default: {
        const f = { 'date-time': '2026-01-01T00:00:00Z', date: '2026-01-01', email: 'user@example.com', uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', uri: 'https://example.com' }[s.format];
        if (f) return f;
        const len = Math.max(s.minLength || 0, 1);
        return 'string'.padEnd(len, 'x').slice(0, s.maxLength || 64);
      }
    }
  }

  /** Схема тела запроса операции (OpenAPI 3 requestBody или Swagger 2 in:body). */
  function requestBodySchema(spec, op) {
    let rb = op.op.requestBody;
    if (rb && rb.$ref) rb = resolveRef(rb.$ref, spec);
    if (rb && rb.content) {
      const ct = Object.keys(rb.content).find((c) => /json/i.test(c));
      if (ct) return { schema: rb.content[ct].schema, example: rb.content[ct].example, required: !!rb.required };
    }
    const bodyParam = (op.op.parameters || []).map((p) => (p.$ref ? resolveRef(p.$ref, spec) : p)).find((p) => p.in === 'body');
    if (bodyParam) return { schema: bodyParam.schema, required: !!bodyParam.required };
    return null;
  }

  Object.assign(ATA, { validate, resolveRef, deepEqual, typeOf, isOpenApi, listOperations, findOperation, responseSchema, checkContract, sampleFromSchema, requestBodySchema });
})(typeof window !== 'undefined' ? window : globalThis);
