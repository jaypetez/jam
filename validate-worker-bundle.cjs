#!/usr/bin/env node
// qa/validate-worker-bundle.js — pre-upload gate for Cloudflare Worker bundles.
//
// Every deploy script in the stack reads a single-file ES module worker and
// PUTs it straight to api.cloudflare.com. Until this file existed, nothing
// looked at the bundle in between: a syntax error, an unreplaced build
// placeholder, a leaked key, or a cron with no `scheduled` handler shipped to
// the edge first and was discovered by the smoke tests afterwards — i.e. after
// production was already broken. This gate refuses the upload instead.
//
// Library use (CommonJS or ESM — named exports are detected by Node):
//   const { assertWorkerBundle } = require('../qa/validate-worker-bundle');
//   assertWorkerBundle({ code, fileName: 'worker.js', metadata, label: SCRIPT_NAME });
//   // prints a report; exits 1 and never returns if the bundle is invalid
//
// CLI use (shell deploys):
//   node qa/validate-worker-bundle.js [--metadata metadata.json] [--cron EXPR]...
//                                      [--expect-secret NAME]... [--label NAME] [--json] path/to/worker.js
//   exit 0 = valid, exit 1 = invalid, exit 2 = usage error
//
// Zero dependencies. Node 18+.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

// Cloudflare limits on the *compressed* script size. Free plan: 3 MiB. Paid: 10 MiB.
const SIZE_WARN_GZ = 3 * 1024 * 1024;
const SIZE_FAIL_GZ = 10 * 1024 * 1024;

// Handlers a module worker's default export may expose.
const HANDLERS = ['fetch', 'scheduled', 'queue', 'email', 'tail'];

// Well-known credential shapes. Workers read secrets from `env`; a literal in
// the bundle means a key was pasted into source.
const SECRET_PATTERNS = [
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/, 'Stripe secret key'],
  [/\brk_(?:live|test)_[A-Za-z0-9]{16,}/, 'Stripe restricted key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}/, 'Resend API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'GitHub fine-grained token'],
  [/\bxox[abpr]-[A-Za-z0-9-]{20,}/, 'Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key block'],
  [/['"]X-Auth-Key['"]\s*:\s*['"][0-9a-f]{37}['"]/, 'hardcoded Cloudflare global API key'],
];

// Build-time placeholder convention used across the stack (ghostmetrics,
// phantometch-proxy): `const NAME = '__NAME__';` gets replaced by the deploy
// script. If the literal survives into the bundle, the replace step silently
// missed and the worker will serve the placeholder. Runtime templates such as
// `html.replace('__UNSUB_URL__', url)` deliberately do NOT match this shape.
const BUILD_PLACEHOLDER_RE = /^[ \t]*(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]__\1__['"]\s*;?/gm;

const CONFLICT_RE = /^(<{7}|={7}|>{7})(\s|$)/m;
const STATIC_IMPORT_RE = /^[ \t]*(?:import|export)\s+(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DEFAULT_EXPORT_RE = /^[ \t]*export\s+default\b/m;
const DEFAULT_EXPORT_OBJECT_RE = /^[ \t]*export\s+default\s*\{/m;
const SERVICE_WORKER_RE = /addEventListener\s*\(\s*['"](?:fetch|scheduled)['"]/;
const ENV_REF_RE = /\benv(?:\.([A-Z][A-Z0-9_]*)\b|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;

function handlerPresent(code, name) {
  // Method form: `async fetch(request, env, ctx) {` / `scheduled(event, env) {`
  const method = new RegExp(`(?:^|[\\s{,;])(?:async\\s+)?${name}\\s*\\([^()]*\\)\\s*\\{`, 'm');
  // Property form: `fetch: async (req) => …`, `fetch: function`, or a bare
  // identifier followed by , } or a newline (`fetch: handleFetch,`). A member
  // expression such as `{ email: user.email }` is ordinary data, not a handler,
  // so the identifier may not be followed by `.` or `(`.
  const prop = new RegExp(`(?:^|[\\s{,])${name}\\s*:\\s*(?:async\\b|function\\b|\\(|[A-Za-z_$][\\w$]*\\s*(?:[,}]|\\r?\\n|$))`, 'm');
  return method.test(code) || prop.test(code);
}

// The part of the bundle where handlers can live: the default-export object
// (`export default {` … first column-0 `}`), or the object a bare
// `export default NAME;` points at. Scanning the whole file instead let
// `{ scheduled: job.scheduled }` in ordinary data satisfy the cron/handler
// cross-check. Falls back to the whole file when the shape is not recognised.
function handlerScope(code) {
  let m = code.match(/^[ \t]*export\s+default\s*\{/m);
  if (!m) {
    const id = code.match(/^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?[ \t]*$/m);
    if (id) m = code.match(new RegExp(`^[ \\t]*(?:const|let|var)\\s+${id[1]}\\s*=\\s*\\{`, 'm'));
  }
  if (!m) return code;
  const rest = code.slice(m.index);
  const close = rest.search(/^\}/m);
  return close > 0 ? rest.slice(0, close + 1) : code;
}

function classExported(code, cls) {
  const decl = new RegExp(`^[ \\t]*export\\s+(?:default\\s+)?class\\s+${cls}\\b`, 'm');
  const list = new RegExp(`^[ \\t]*export\\s*\\{[^}]*\\b${cls}\\b[^}]*\\}`, 'm');
  return decl.test(code) || list.test(code);
}

function syntaxCheck(code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: code, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return `syntax check could not run: ${r.error.message}`;
  if (r.status === 0) return null;
  const lines = (r.stderr || '').split('\n')
    .filter(l => l.trim() && !/^\s+at /.test(l) && !/^Node\.js v/.test(l) && !/^\(node:\d+\)/.test(l));
  return lines.slice(0, 6).join('\n') || `node --check exited ${r.status}`;
}

function todayUTC() { return new Date().toISOString().slice(0, 10); }

/**
 * Validate a worker bundle. Never exits; returns a result object.
 * @param {object} opts
 * @param {string} [opts.code]       bundle source (or pass filePath)
 * @param {string} [opts.filePath]   path to read the bundle from
 * @param {string} [opts.fileName]   form-part filename the upload will use (default 'worker.js')
 * @param {object} [opts.metadata]   the upload metadata object (main_module, bindings, triggers, …)
 * @param {string[]} [opts.crons]    crons set outside metadata (PUT …/schedules)
 * @param {string[]} [opts.placeholders] extra literals that must NOT survive into the bundle
 * @param {string[]} [opts.expectedSecrets] binding names the script deliberately leaves out of
 *   metadata.bindings because they already exist on the live script and ride along via
 *   keep_bindings. Reads of these are silent; a read of any OTHER undeclared name still warns,
 *   so the warning only fires when something is genuinely off.
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:object}}
 */
function validateWorkerBundle(opts = {}) {
  const errors = [];
  const warnings = [];
  const fileName = opts.fileName || 'worker.js';
  const metadata = opts.metadata || null;

  let code = opts.code;
  if (code == null) {
    if (!opts.filePath) throw new TypeError('validateWorkerBundle: pass code or filePath');
    try { code = fs.readFileSync(opts.filePath, 'utf8'); }
    catch (e) { return { ok: false, errors: [`cannot read bundle ${opts.filePath}: ${e.message}`], warnings, stats: {} }; }
  }
  if (Buffer.isBuffer(code)) code = code.toString('utf8');

  const rawBytes = Buffer.byteLength(code, 'utf8');
  const gzBytes = rawBytes ? zlib.gzipSync(code, { level: 6 }).length : 0;
  const stats = { rawBytes, gzBytes, lines: code ? code.split('\n').length : 0, checks: 0 };
  const check = (cond, msg, warnOnly) => { stats.checks++; if (!cond) (warnOnly ? warnings : errors).push(msg); };

  // 1. Substance
  check(code.trim().length > 0, 'bundle is empty');
  if (!code.trim()) return { ok: false, errors, warnings, stats };

  // 2. Encoding damage / conflict markers
  check(!code.includes('�'), 'bundle contains U+FFFD replacement characters — source is not valid UTF-8 or was mangled');
  check(code.charCodeAt(0) !== 0xFEFF, 'bundle starts with a UTF-8 BOM — strip it', true);
  const conflict = code.match(CONFLICT_RE);
  check(!conflict, conflict && `unresolved git conflict marker at line ${code.slice(0, conflict.index).split('\n').length}`);

  // 3. Size (Cloudflare limits are on compressed size)
  check(gzBytes <= SIZE_FAIL_GZ, `compressed bundle is ${fmt(gzBytes)} — over the 10 MiB Workers ceiling`);
  check(gzBytes <= SIZE_WARN_GZ, `compressed bundle is ${fmt(gzBytes)} — over the 3 MiB Free-plan ceiling (fine on Paid)`, true);

  // 4. Parses as an ES module
  const syntaxErr = syntaxCheck(code);
  check(!syntaxErr, syntaxErr && `does not parse as an ES module:\n      ${syntaxErr.replace(/\n/g, '\n      ')}`);

  // 5. Module-worker shape
  const isServiceWorker = SERVICE_WORKER_RE.test(code);
  const hasDefault = DEFAULT_EXPORT_RE.test(code);
  check(!(isServiceWorker && !hasDefault), 'uses addEventListener("fetch") service-worker syntax — module uploads (main_module) need `export default { fetch() {} }`');
  check(hasDefault || isServiceWorker, 'no `export default` — a module worker must default-export its handlers');
  const scope = handlerScope(code);
  const present = HANDLERS.filter(h => handlerPresent(scope, h));
  if (hasDefault && present.length === 0) {
    check(false, 'default export exposes none of fetch/scheduled/queue/email/tail — the worker would do nothing', !DEFAULT_EXPORT_OBJECT_RE.test(code));
  }

  // 6. Build placeholders that were never replaced
  for (const m of code.matchAll(BUILD_PLACEHOLDER_RE)) {
    check(false, `build placeholder '__${m[1]}__' was never replaced (line ${lineOf(code, m.index)}) — the deploy build step missed it`);
  }
  for (const p of opts.placeholders || []) {
    check(!code.includes(p), `placeholder ${JSON.stringify(p)} survived into the bundle`);
  }

  // 7. Leaked credentials
  for (const [re, what] of SECRET_PATTERNS) {
    const m = code.match(re);
    check(!m, m && `looks like a ${what} literal at line ${lineOf(code, m.index)} — read it from env instead`);
  }

  // 8. Imports. A single-file upload has nothing else to resolve against.
  const compatFlags = (metadata && metadata.compatibility_flags) || [];
  const seenSpecs = new Set();
  for (const m of code.matchAll(STATIC_IMPORT_RE)) {
    const spec = m[1];
    if (seenSpecs.has(spec)) continue;
    seenSpecs.add(spec);
    if (spec.startsWith('cloudflare:')) continue;
    if (spec.startsWith('node:')) {
      check(!metadata || compatFlags.includes('nodejs_compat'),
        `imports ${spec} but metadata.compatibility_flags lacks "nodejs_compat"`);
      continue;
    }
    check(false, `imports ${JSON.stringify(spec)} (line ${lineOf(code, m.index)}) — a single-file upload cannot resolve it; bundle it in or inline it`);
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT_RE)) {
    const spec = m[1];
    if (spec.startsWith('cloudflare:') || spec.startsWith('node:')) continue;
    check(false, `dynamic import(${JSON.stringify(spec)}) at line ${lineOf(code, m.index)} will not resolve in a single-file worker (ignore if this is inside embedded page HTML)`, true);
  }

  // 9. Hygiene
  const dbg = code.match(/(?:^|[;{}\n])[ \t]*debugger\s*(?:;|\n|$)/);
  check(!dbg, dbg && `\`debugger\` statement at line ${lineOf(code, dbg.index)}`, true);

  // 10. Cross-checks against the upload metadata
  const crons = [...((metadata && metadata.triggers && metadata.triggers.crons) || []), ...(opts.crons || [])];
  if (crons.length) {
    check(present.includes('scheduled'), `cron trigger(s) ${crons.map(c => JSON.stringify(c)).join(', ')} declared but the bundle has no \`scheduled\` handler — the cron would fire into nothing`);
  }
  if (metadata) {
    check(metadata.main_module === fileName,
      `metadata.main_module is ${JSON.stringify(metadata.main_module)} but the bundle is uploaded as ${JSON.stringify(fileName)} — Cloudflare will reject or run the wrong entry`);

    if (metadata.compatibility_date) {
      check(/^\d{4}-\d{2}-\d{2}$/.test(metadata.compatibility_date), `compatibility_date ${JSON.stringify(metadata.compatibility_date)} is not YYYY-MM-DD`);
      check(metadata.compatibility_date <= todayUTC(), `compatibility_date ${metadata.compatibility_date} is in the future — Cloudflare rejects dates after today (${todayUTC()})`);
    }

    const bindings = Array.isArray(metadata.bindings) ? metadata.bindings : null;
    if (bindings) {
      const declared = new Set();
      for (const b of bindings) {
        if (!b || !b.name) { check(false, `binding without a name: ${JSON.stringify(b)}`); continue; }
        declared.add(b.name);
        if ((b.type === 'secret_text' || b.type === 'plain_text') && !(typeof b.text === 'string' && b.text.length > 0)) {
          check(false, `${b.type} binding ${b.name} has an empty value — the env var behind it is unset`);
        }
        if (b.type === 'durable_object_namespace' && !b.script_name) {
          check(!!b.class_name, `durable_object_namespace ${b.name} has no class_name`);
          if (b.class_name) check(classExported(code, b.class_name), `Durable Object binding ${b.name} expects \`export class ${b.class_name}\` but the bundle does not export it`);
        }
      }
      const referenced = new Set();
      for (const m of code.matchAll(ENV_REF_RE)) referenced.add(m[1] || m[2]);
      // A binding read through a helper — `edgeLimit(env, 'AUTH_FLOOD', key)`
      // doing `env[name]` — never appears as `env.AUTH_FLOOD`; its name does
      // appear as a string literal. Count that as a read so the unused-binding
      // warning stays meaningful (a warning that fires on every deploy is one
      // nobody reads).
      for (const b of bindings) {
        if (b && b.name && !referenced.has(b.name) && new RegExp(`['"]${b.name}['"]`).test(code)) referenced.add(b.name);
      }
      const keep = metadata.keep_bindings || [];
      const expected = [...new Set(opts.expectedSecrets || [])];
      // An explicit expectedSecrets list is the script's claim that these
      // names exist on the live script and survive the PUT through
      // keep_bindings. That claim is false if secret_text is not kept.
      if (expected.length) {
        check(keep.includes('secret_text'), `expectedSecrets lists ${expected.join(', ')} but metadata.keep_bindings (${JSON.stringify(keep)}) does not keep secret_text — the upload would delete them`);
        const stale = expected.filter(n => !referenced.has(n)).sort();
        check(stale.length === 0, stale.length && `expectedSecrets lists ${stale.join(', ')} but the bundle never reads ${stale.length === 1 ? 'it' : 'them'} — stale list`, true);
      }
      const undeclared = [...referenced].filter(n => !declared.has(n) && !expected.includes(n)).sort();
      if (undeclared.length) {
        const list = undeclared.map(n => `env.${n}`).join(', ');
        if (expected.length) {
          check(false, `${list} referenced but not in metadata.bindings and not in expectedSecrets (${expected.join(', ')}) — undefined at runtime unless it is a live binding you forgot to list`, true);
        } else if (keep.length) {
          check(false, `${list} referenced but not in metadata.bindings — fine only if each is an existing ${keep.join('/')} binding carried by keep_bindings; anything else is undefined at runtime`, true);
        } else {
          check(false, `${list} referenced but not declared in metadata.bindings and keep_bindings is empty — undefined at runtime`);
        }
      }
      const unused = [...declared].filter(n => !referenced.has(n)).sort();
      check(unused.length === 0, unused.length && `bindings declared but never read via env: ${unused.join(', ')}`, true);
    }
  }

  return { ok: errors.length === 0, errors, warnings, stats, handlers: present };
}

function lineOf(code, idx) { return code.slice(0, idx).split('\n').length; }
function fmt(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
  return n + ' B';
}

function printReport(result, label, out = console) {
  const tag = label ? ` ${label}` : '';
  const s = result.stats || {};
  for (const w of result.warnings) out.warn(`  ⚠ ${w}`);
  for (const e of result.errors) out.error(`  ✗ ${e}`);
  if (result.ok) {
    const h = result.handlers && result.handlers.length ? ` · handlers: ${result.handlers.join(',')}` : '';
    out.log(`  ✔ bundle valid${tag}: ${fmt(s.rawBytes || 0)} (${fmt(s.gzBytes || 0)} gzip), ${s.lines || 0} lines${h} · ${s.checks || 0} checks, ${result.warnings.length} warning(s)`);
  } else {
    out.error(`  ✗ bundle INVALID${tag}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  }
}

/**
 * Validate, print, and refuse to continue on failure. For deploy scripts.
 * Returns the result on success; calls process.exit(1) on failure.
 */
function assertWorkerBundle(opts) {
  const label = opts.label || opts.fileName || 'worker';
  console.log(`Validating worker bundle (${label}) before upload...`);
  const result = validateWorkerBundle(opts);
  printReport(result, label);
  if (!result.ok) {
    console.error(`\n\u{1F6AB} BUNDLE VALIDATION FAILED (${label}) — refusing to upload. Nothing was deployed.`);
    process.exit(1);
  }
  return result;
}

// ---- CLI ----
function cli(argv) {
  const args = argv.slice(2);
  const opts = { crons: [], placeholders: [], expectedSecrets: [] };
  let file = null, json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--metadata') opts.metadata = JSON.parse(fs.readFileSync(args[++i], 'utf8'));
    else if (a === '--cron') opts.crons.push(args[++i]);
    else if (a === '--placeholder') opts.placeholders.push(args[++i]);
    else if (a === '--expect-secret') opts.expectedSecrets.push(args[++i]);
    else if (a === '--label') opts.label = args[++i];
    else if (a === '--file-name') opts.fileName = args[++i];
    else if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') { usage(); return 0; }
    else if (a.startsWith('-')) { console.error(`unknown flag ${a}`); usage(); return 2; }
    else if (file) { console.error('only one bundle path allowed'); return 2; }
    else file = a;
  }
  if (!file) { usage(); return 2; }
  opts.filePath = file;
  if (!opts.fileName && opts.metadata && opts.metadata.main_module) opts.fileName = opts.metadata.main_module;
  const result = validateWorkerBundle(opts);
  if (json) { console.log(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1; }
  printReport(result, opts.label || path.basename(file));
  if (!result.ok) console.error(`\n\u{1F6AB} BUNDLE VALIDATION FAILED — do not upload.`);
  return result.ok ? 0 : 1;
}
function usage() {
  console.error('usage: node validate-worker-bundle.js [--metadata metadata.json] [--cron EXPR]... [--placeholder LIT]... [--expect-secret NAME]... [--file-name worker.js] [--label NAME] [--json] <bundle.js>');
}

module.exports = { validateWorkerBundle, assertWorkerBundle, printReport, HANDLERS, SECRET_PATTERNS };

if (require.main === module) process.exit(cli(process.argv));
