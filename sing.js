#!/usr/bin/env node
"use strict";
/**
 * sing — тонкий CLI поверх Singularity API (self-contained пакет, см. AGENTS.md рядом).
 *
 * Зачем: MCP отдаёт полные объекты (listTasks ~600+ задач целиком) → жжёт контекст.
 * Этот CLI ходит в API live, а в stdout печатает только компактную проекцию нужных
 * полей (или метрики). Сырой полный дамп — опционально в файл (--out) для jq, не в контекст.
 *
 * Аутентификация: env SINGULARITY_BASE_URL / SINGULARITY_ACCESS_TOKEN, затем MCP-конфиг Codex,
 * затем ~/.claude.json. Токен НИКОГДА не печатается.
 *
 * Канон правил и справочник — AGENTS.md в этой директории.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
// ApiClient — локальная копия из MCP-пакета (client.js рядом; axios из ./node_modules).
const { ApiClient } = require(path.join(__dirname, "client.js"));

// Не падать с EPIPE, когда вывод обрезан пайпом (| head / | jq).
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

// --- Reference-проекты: настраиваются под аккаунт через env (по умолчанию пусто) ---
// Singularity не помечает проекты как «справочные» — это пользовательская семантика. Задаётся через:
//   SINGULARITY_REFERENCE_SPHERE   — id проекта-сферы; все проекты под ней считаются reference;
//   SINGULARITY_REFERENCE_PROJECTS — список id проектов через запятую (явный набор).
// Если ничего не задано — фильтры (--no-reference/--active/--candidate) и метрика reference никого
// не относят к reference (нейтральный дефолт). См. README → Настройка.
function referenceConfig() {
  return {
    sphere: process.env.SINGULARITY_REFERENCE_SPHERE || null,
    fallback: flagList(process.env.SINGULARITY_REFERENCE_PROJECTS),
  };
}

const TASK_DEFAULT_FIELDS = ["id", "title", "projectId", "tags", "start", "deferred", "deadline", "parentOrder"];

// --------------------------- auth ---------------------------

function resolveAuth() {
  let baseUrl = process.env.SINGULARITY_BASE_URL;
  let token = process.env.SINGULARITY_ACCESS_TOKEN;
  if (baseUrl && token) return { baseUrl, token };

  // Первый фолбэк: args глобального MCP-сервера в ~/.codex/config.toml.
  try {
    const config = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    ({ baseUrl, token } = authFromArgs(findCodexSingularityArgs(config), baseUrl, token));
  } catch (_) { /* ignore */ }

  // Второй фолбэк: args запуска MCP-сервера в ~/.claude.json.
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    ({ baseUrl, token } = authFromArgs(findSingularityArgs(cfg), baseUrl, token));
  } catch (_) { /* ignore */ }

  baseUrl = baseUrl || "https://api.singularity-app.com";
  if (!token) {
    fail("Не найден access token. Задай env SINGULARITY_ACCESS_TOKEN или настрой MCP singularity в Codex/Claude.");
  }
  return { baseUrl, token };
}

function authFromArgs(args, baseUrl, token) {
  if (!args) return { baseUrl, token };
  const bi = args.indexOf("--baseUrl");
  const ti = args.indexOf("--accessToken");
  if (!baseUrl && bi >= 0) baseUrl = args[bi + 1];
  if (!token && ti >= 0) token = args[ti + 1];
  return { baseUrl, token };
}

function findCodexSingularityArgs(config) {
  const header = /^\[mcp_servers\.singularity\][ \t]*$/m.exec(config);
  if (!header) return null;
  const rest = config.slice(header.index + header[0].length);
  const nextSection = rest.search(/^\[/m);
  const section = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  const args = section.match(/^args\s*=\s*\[([^\]]*)\]/m);
  if (!args) return null;
  const values = [];
  for (const item of args[1].matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    try { values.push(JSON.parse(`"${item[1]}"`)); } catch (_) { return null; }
  }
  return values.length ? values : null;
}

// Рекурсивно ищет массив args, содержащий и mcp.js singularity, и --accessToken.
function findSingularityArgs(node) {
  if (Array.isArray(node)) {
    const joined = node.join(" ");
    if (joined.includes("--accessToken") && /singularity[\/\\]mcp\.js/.test(joined)) return node;
    for (const v of node) { const r = findSingularityArgs(v); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) { const r = findSingularityArgs(v); if (r) return r; }
  }
  return null;
}

function client() {
  const { baseUrl, token } = resolveAuth();
  const c = new ApiClient({ baseUrl, enableLogging: false });
  c.setAccessToken(token);
  return c;
}

// --------------------------- helpers ---------------------------

function fail(msg) {
  process.stderr.write(`sing: ${msg}\n`);
  process.exit(1);
}

function name(obj) {
  return obj && (obj.title != null ? obj.title : obj.name);
}

// API оборачивает списки: {tasks:[…]}/{projects:[…]}/{tags:[…]}. Распаковываем в массив.
function asArray(resp, key) {
  if (Array.isArray(resp)) return resp;
  if (resp && Array.isArray(resp[key])) return resp[key];
  if (resp && typeof resp === "object") { const v = Object.values(resp).find(Array.isArray); if (v) return v; }
  return [];
}
const getTasks = async (c, params) => asArray(await c.listTasks(params || {}), "tasks");
const getProjects = async (c) => asArray(await c.listProjects(), "projects");

// Текущий PATCH /v2/task/:id запрещает `id` в JSON-теле, а вендорный ApiClient пока отправляет
// объект целиком. Держим совместимость здесь, не меняя вендорный client.js.
function taskUpdateRequest(task) {
  if (!task || !task.id) throw new Error("для обновления задачи нужен id");
  const { id, ...data } = task;
  return { id, data };
}

async function updateTask(c, task) {
  const { id, data } = taskUpdateRequest(task);
  const response = await c.client.patch(`/v2/task/${id}`, data, c.createRequestConfig());
  return response.data;
}

function isNotFound(err) {
  return Boolean(err && err.response && err.response.status === 404);
}

// После deleteDate прямой GET теперь отвечает 404. Для идемпотентности и проверки ищем задачу
// в общей выдаче, явно включающей удалённые и экземпляры повторений.
async function getTaskIncludingRemoved(c, id) {
  try {
    return await c.getTask(id);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const tasks = await getTasks(c, {
      includeRemoved: true,
      includeArchived: true,
      includeAllRecurrenceInstances: true,
    });
    const task = tasks.find((item) => item.id === id);
    if (task) return task;
    throw err;
  }
}

// Множество reference-проектов: всё под настроенной сферой + явный набор (см. referenceConfig).
function referenceProjectIds(projects, cfg) {
  const { sphere, fallback } = cfg || referenceConfig();
  const ids = new Set(fallback);
  if (!sphere) return ids; // сфера не настроена — только явный набор
  const byId = new Map(projects.map((p) => [p.id, p]));
  const underReference = (p) => {
    let cur = p, guard = 0;
    while (cur && guard++ < 50) {
      if (cur.id === sphere || cur.parent === sphere) return true;
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    return false;
  };
  for (const p of projects) if (underReference(p)) ids.add(p.id);
  return ids;
}

// Карта имя→id и id→имя по тегам.
async function tagMaps(c) {
  const tags = asArray(await c.listTags(), "tags");
  const nameToId = new Map(), idToName = new Map();
  for (const t of tags) { nameToId.set(name(t), t.id); idToName.set(t.id, name(t)); }
  return { nameToId, idToName, tags };
}

function projectTask(t, fields, idToName) {
  const out = {};
  for (const f of fields) {
    if (f === "tags" && idToName) out.tags = (t.tags || []).map((id) => idToName.get(id) || id);
    else out[f] = t[f];
  }
  return out;
}

function emit(rows, format, fields) {
  if (format === "count") { process.stdout.write(String(rows.length) + "\n"); return; }
  if (format === "json") { process.stdout.write(JSON.stringify(rows, null, 2) + "\n"); return; }
  if (format === "tsv") {
    process.stdout.write(fields.join("\t") + "\n");
    for (const r of rows) {
      process.stdout.write(fields.map((f) => fmtCell(r[f])).join("\t") + "\n");
    }
    return;
  }
  // jsonl (default) — jq-friendly, по строке на объект
  for (const r of rows) process.stdout.write(JSON.stringify(r) + "\n");
}

function fmtCell(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(",");
  return String(v).replace(/\s+/g, " ").trim();
}

// Сырой дамп в файл; в stdout — только сводка.
function dumpRaw(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const n = Array.isArray(data) ? data.length : 1;
  process.stdout.write(`Записано ${n} объектов → ${file}\n`);
}

// --------------------------- argv ---------------------------

function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
        else { flags[a.slice(2)] = next; i++; }
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function flagList(v) {
  if (v == null || v === true) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

// Допустимые флаги по команде — для «падать на неизвестном флаге» (не молча игнорировать).
// Команды только с позиционными аргументами — пустой список.
const KNOWN_FLAGS = {
  tasks: ["project", "tag", "query", "no-reference", "active", "candidate", "next-action", "deferred", "inbox", "done", "all", "format", "fields", "tag-ids", "out", "due"],
  task: ["json"],
  projects: ["format", "out"],
  tags: [],
  metrics: ["json", "done", "all"],
  "tag-swap": ["add", "remove", "force"],
  note: ["html", "file"],
  create: ["title", "project", "tags", "note"],
  done: [],
  rename: [],
  move: ["project", "section"],
  "heal-groups": ["project", "dry"],
  bucket: ["today", "tomorrow", "week", "none"],
  archive: [],
  checklist: ["add", "list", "delete", "replace-file"],
  deadline: ["date"],
  "project-rename": [],
  "project-create": ["title", "parent"],
};
// Неизвестные флаги для команды (пустой массив = всё ок). Неизвестная команда → пусто (валидируется
// отдельно диспетчером); help/undefined тоже не валидируются.
function unknownFlags(cmd, flags) {
  const known = KNOWN_FLAGS[cmd];
  if (!known) return [];
  const set = new Set(known);
  return Object.keys(flags).filter((k) => !set.has(k));
}

// --------------------------- write helpers ---------------------------

// Поля done/archive определены спайком по живому API (см. историю):
// - `complete:1` сам по себе НЕ убирает задачу из listTasks (это и есть известный баг);
// - `archived`/`removed` API молча игнорирует (не сохраняются);
// - рабочий рычаг «убрать из активных» — `deleteDate` (задача уходит в корзину, прямой getTask
//   отвечает 404, но она видна с includeRemoved:true). Снятие `start` — через `null`.
const nowIso = () => new Date().toISOString();
// done = закрыть + реально убрать из активных (как ручная отметка «выполнено»).
const DONE_PATCH = () => ({ complete: 1, deleteDate: nowIso() });
// archive = убрать без отметки «выполнено» (разбор stale-задач).
const ARCHIVE_PATCH = () => ({ deleteDate: nowIso() });

// Предикаты активности. Опираются на ВИДИМЫЕ в выдаче listTasks поля: complete (остаётся, баг) и
// deleteDate (сервер сам прячет такие из дефолта, но фильтр ловит легаси). archived/removed — мусор.
const isArchived = (t) => Boolean(t && t.deleteDate);
const isDone = (t) => Boolean(t && (t.complete || t.deleteDate));
const isActive = (t) => !isDone(t);
// Истинный инбокс: задача поймана «без проекта и без даты» (дефолт захвата). Назначили проект ИЛИ
// коробочку-дату (start/deferred) → разобрана, из инбокса ушла. Это канонная выборка «Входящих».
const isInboxTask = (t) => Boolean(t) && !t.projectId && !t.start && !t.deferred;

// «День D в GMT+3» хранится как (D-1)T21:00:00.000Z. Невалидный формат → null.
function dateToGMT3Iso(yyyymmdd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(yyyymmdd))) return null;
  const d = new Date(`${yyyymmdd}T00:00:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
// Сегодня в GMT+3 — через Intl (не зависит от TZ машины/CI, без багов на границе суток).
function todayGMT3Iso() {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
  return dateToGMT3Iso(ymd);
}
function tomorrowGMT3Iso(todayIso = todayGMT3Iso()) {
  return new Date(new Date(todayIso).getTime() + 86400000).toISOString();
}
// Класс срочности задачи по локальному дню GMT+3. Окно «сегодня» D = [lower, upper) =
// [(D-1)T21:00Z, D·T21:00Z); Москва — фиксированный UTC+3 (без DST), поэтому upper = lower + 24ч.
// Смотрим И start, И deadline: дата в прошлом → "overdue", дата в окне сегодня → "today".
function dueClasses(task, lowerIso, upperIso) {
  const set = new Set();
  for (const v of [task && task.start, task && task.deadline]) {
    if (!v) continue;
    if (v < lowerIso) set.add("overdue");
    else if (v < upperIso) set.add("today");
  }
  return set;
}
// Границы окна «сегодня» в GMT+3 (не чистая — зависит от часов; в тестах dueClasses берёт границы явно).
function todayWindowGMT3() {
  const lower = todayGMT3Iso();
  const upper = new Date(new Date(lower).getTime() + 86400000).toISOString();
  return { lower, upper };
}

function taskMatchesQuery(task, query) {
  return String(task && task.title || "").toLocaleLowerCase("ru-RU")
    .includes(String(query).toLocaleLowerCase("ru-RU"));
}

function checklistTitlesFromText(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// Карта имя→id и id→имя по проектам (аналог tagMaps).
async function projectMaps(c) {
  const projects = await getProjects(c);
  const nameToId = new Map(), idToName = new Map();
  for (const p of projects) { nameToId.set(name(p), p.id); idToName.set(p.id, name(p)); }
  return { nameToId, idToName, projects };
}
// P-… → как есть; иначе имя→id; не найдено → null.
function resolveProjectSafe(v, pm) {
  if (v == null || v === true) return null;
  const s = String(v);
  if (/^P-/.test(s)) return s;
  return pm.nameToId.get(s) || null;
}
function resolveProject(v, pm) {
  const id = resolveProjectSafe(v, pm);
  if (!id) fail(`неизвестный проект: ${v} (sing projects)`);
  return id;
}

// --------------------------- task groups (секции) ---------------------------
// У каждого проекта есть ровно одна fake-группа (дефолтная псевдо-секция, куда клиент кладёт задачи
// «без секции»). Плюс могут быть реальные именованные секции. Задача с group=null или ссылкой на
// удалённую/чужую секцию выпадает из проекта в клиентский список «без проекта».
// listTaskGroups фильтр projectId игнорирует (отдаёт все) — фильтруем по g.parent на клиенте.
const getGroups = async (c) => asArray(await c.listTaskGroups({}), "taskGroups");

// Дефолтная секция проекта: fake-группа; если её нет — верхняя реальная секция; нет групп → null.
function defaultGroupId(groups, projectId) {
  const mine = groups.filter((g) => g.parent === projectId);
  if (!mine.length) return null;
  const fake = mine.find((g) => g.fake);
  if (fake) return fake.id;
  return mine.slice().sort((a, b) => (a.parentOrder || 0) - (b.parentOrder || 0))[0].id;
}

// Карта projectId → Set(валидных group id) — чтобы отличить «битую» ссылку от валидной секции.
function groupsByProject(groups) {
  const m = new Map();
  for (const g of groups) {
    if (!g.parent) continue;
    if (!m.has(g.parent)) m.set(g.parent, new Set());
    m.get(g.parent).add(g.id);
  }
  return m;
}

// Задача-сирота внутри проекта: есть projectId с известными группами, но group отсутствует или
// указывает на секцию не из этого проекта (удалённую/чужую). Без projectId — не наш случай (нечем
// чинить группой). Проект с неизвестными группами — тоже пропускаем (нет цели).
function needsGroupHeal(task, validByProject) {
  if (!task || !task.projectId) return false;
  const valid = validByProject.get(task.projectId);
  if (!valid || valid.size === 0) return false;
  if (!task.group) return true;
  return !valid.has(task.group);
}

// id из positional или из stdin (whitespace/newline). Пусто → fail.
function resolveIds(positional) {
  if (positional && positional.length) return positional;
  if (process.stdin.isTTY) fail("нужны id: аргументами или через stdin");
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch (_) { /* нет stdin */ }
  const ids = raw.split(/\s+/).filter(Boolean);
  if (!ids.length) fail("нужны id: аргументами или через stdin");
  return ids;
}

// Последовательный батч (последовательно намеренно — не ловить rate-limit). Частичный сбой не
// прерывает остальные: ошибки построчно в stderr, при сбое — ненулевой exit code.
async function runBatch(ids, fn) {
  let okN = 0, failN = 0;
  for (const id of ids) {
    try { await fn(id); okN++; }
    catch (e) {
      failN++;
      const msg = e && e.response ? `HTTP ${e.response.status}` : (e && e.message) || String(e);
      process.stderr.write(`  ! ${id}: ${msg}\n`);
    }
  }
  if (ids.length > 1) process.stdout.write(`итого: ok=${okN} fail=${failN}\n`);
  if (failN) process.exitCode = 1;
}

// --------------------------- commands ---------------------------

async function cmdTasks(flags) {
  if (flags.query === true) fail('нужен текст: --query "фрагмент заголовка"');
  const c = client();
  // done/archive выставляют deleteDate — такие задачи сервер прячет из дефолтного listTasks.
  // Чтобы --done/--all реально их показали, просим у API removed/archived.
  const listParams = {};
  if (flags.project) listParams.projectId = flags.project;
  if (flags.done || flags.all) { listParams.includeRemoved = true; listParams.includeArchived = true; }
  const [tasks, projects, tm] = await Promise.all([
    getTasks(c, listParams),
    getProjects(c),
    tagMaps(c),
  ]);

  if (flags.out) return dumpRaw(flags.out, tasks); // сырой полный дамп — в файл, не в контекст

  const refIds = referenceProjectIds(projects);
  const wantTags = flagList(flags.tag).map((n) => tm.nameToId.get(n) || n);
  const waitingId = tm.nameToId.get("Waiting");
  const brainstormId = tm.nameToId.get("Мозгоштурм");

  let rows = tasks;
  // По умолчанию скрываем выполненные/архивные (фикс бага: complete:1 остаётся в listTasks API).
  if (!(flags.done || flags.all)) rows = rows.filter(isActive);
  if (flags["no-reference"] || flags.active || flags.candidate || flags["next-action"]) {
    rows = rows.filter((t) => !refIds.has(t.projectId));
  }
  if (flags.active || flags.candidate || flags["next-action"]) {
    rows = rows.filter((t) => !t.deferred);
  }
  if (flags.candidate || flags["next-action"]) {
    rows = rows.filter((t) => !(t.tags || []).includes(waitingId) && !(t.tags || []).includes(brainstormId));
  }
  if (flags.deferred != null) {
    const want = String(flags.deferred) !== "false";
    rows = rows.filter((t) => Boolean(t.deferred) === want);
  }
  if (flags.query) rows = rows.filter((t) => taskMatchesQuery(t, flags.query));
  if (flags.inbox) rows = rows.filter(isInboxTask); // истинный инбокс: без проекта И без даты
  if (flags.due) {
    const want = flagList(flags.due);
    const bad = want.filter((w) => w !== "today" && w !== "overdue");
    if (bad.length) fail(`--due принимает today|overdue (можно через запятую), не: ${bad.join(", ")}`);
    const { lower, upper } = todayWindowGMT3();
    rows = rows.filter((t) => { const cls = dueClasses(t, lower, upper); return want.some((w) => cls.has(w)); });
  }
  if (wantTags.length) rows = rows.filter((t) => wantTags.every((id) => (t.tags || []).includes(id)));

  const fields = flags.fields ? flagList(flags.fields) : TASK_DEFAULT_FIELDS;
  const idToName = flags["tag-ids"] ? null : tm.idToName;
  emit(rows.map((t) => projectTask(t, fields, idToName)), flags.format || "jsonl", fields);
}

async function cmdTask(positional, flags) {
  const id = positional[0];
  if (!id) fail("usage: sing task <id> [--json]");
  const c = client();
  const t = await c.getTask(id);
  if (flags.json) { process.stdout.write(JSON.stringify(t, null, 2) + "\n"); return; }
  const tm = await tagMaps(c);
  process.stdout.write(JSON.stringify(projectTask(t, [...TASK_DEFAULT_FIELDS, "note"], tm.idToName), null, 2) + "\n");
}

async function cmdProjects(flags) {
  const c = client();
  const projects = await getProjects(c);
  if (flags.out) return dumpRaw(flags.out, projects);
  const fields = ["id", "name", "parent", "parentOrder"];
  const rows = projects
    .map((p) => ({ id: p.id, name: name(p), parent: p.parent || "", parentOrder: p.parentOrder }))
    .sort((a, b) => (a.parentOrder || 0) - (b.parentOrder || 0));
  emit(rows, flags.format || "jsonl", fields);
}

async function cmdTags(flags) {
  const c = client();
  const tm = await tagMaps(c);
  const rows = tm.tags.map((t) => ({ id: t.id, title: name(t) }));
  emit(rows, flags.format || "jsonl", ["id", "title"]);
}

async function cmdMetrics(flags) {
  const c = client();
  const showAll = flags.done || flags.all;
  const listParams = showAll ? { includeRemoved: true, includeArchived: true } : {};
  const [tasks, projects, tm] = await Promise.all([getTasks(c, listParams), getProjects(c), tagMaps(c)]);
  const refIds = referenceProjectIds(projects);
  const has = (t, tag) => (t.tags || []).includes(tm.nameToId.get(tag));

  // По умолчанию метрики считаются по активным (без выполненных/архивных). --done/--all — по всем.
  const live = showAll ? tasks : tasks.filter(isActive);

  const total = live.length;
  const reference = live.filter((t) => refIds.has(t.projectId)).length;
  const deferred = live.filter((t) => t.deferred).length;
  const activeLoad = total - reference - deferred;
  const review = live.filter((t) => has(t, "review")).length;
  const research = live.filter((t) => has(t, "research")).length;
  const decompose = live.filter((t) => has(t, "decompose")).length;
  const inbox = live.filter(isInboxTask).length; // без проекта И без коробочки-даты (§5)

  const m = {
    total, reference, deferred, activeLoad, inbox,
    review, research, decompose,
    backpressure: {
      // Лимит стока review снят 2026-07-11 — число на ревью остаётся видимой метрикой, но не блокирует подхват.
      researchInput: research > 10 ? "ALERT >10: затор на входе" : "ok",
    },
  };
  if (flags.format === "json" || flags.json) { process.stdout.write(JSON.stringify(m, null, 2) + "\n"); return; }
  process.stdout.write(
    `Всего:            ${total}\n` +
    `Reference:        ${reference}\n` +
    `Deferred:         ${deferred}\n` +
    `Активная нагрузка: ${activeLoad}  (Всего − Reference − Deferred)\n` +
    `Входящие:         ${inbox}\n` +
    `На ревью (review): ${review}\n` +
    `research-очередь:  ${research}   ${m.backpressure.researchInput}\n` +
    `decompose:        ${decompose}\n`
  );
}

// Guard §12: свап на review без брифа теряет бриф — задача уходит «на ревью» пустой.
// Возвращает причину-строку (блок) или null (пропуск). note-ref "N-T-…" = бриф записан;
// пустой/whitespace note = брифа нет. --force снимает блок для ручных исключений.
function reviewGuardReason(task, addNames, force) {
  if (force) return null;
  if (!Array.isArray(addNames) || !addNames.includes("review")) return null;
  const note = task && task.note != null ? String(task.note).trim() : "";
  if (!note) return "нельзя ставить review без брифа: заметка задачи пуста — сначала `sing note <id> …`, либо повтори с --force";
  return null;
}

async function cmdTagSwap(positional, flags) {
  const id = positional[0];
  if (!id) fail("usage: sing tag-swap <id> --add NAME --remove NAME [--force]");
  const c = client();
  const tm = await tagMaps(c);
  const t = await c.getTask(id);
  const resolve = (n) => tm.nameToId.get(n) || fail(`неизвестный тег: ${n}`);
  const addNames = flagList(flags.add);
  const guard = reviewGuardReason(t, addNames, flags.force);
  if (guard) fail(guard);
  const add = addNames.map(resolve);
  const remove = new Set(flagList(flags.remove).map(resolve));
  const next = Array.from(new Set([...(t.tags || []).filter((x) => !remove.has(x)), ...add]));
  await updateTask(c, { id, tags: next });
  // Встроенная верификация: перечитываем и печатаем итоговые теги.
  const after = await c.getTask(id);
  process.stdout.write(
    `tag-swap ${id}\n  было:  ${(t.tags || []).map((x) => tm.idToName.get(x) || x).join(", ") || "—"}\n` +
    `  стало: ${(after.tags || []).map((x) => tm.idToName.get(x) || x).join(", ") || "—"}\n`
  );
}

async function cmdNote(positional, flags) {
  const id = positional[0];
  if (!id) fail("usage: sing note <id> (--html '...' | --file PATH)");
  let note = flags.html;
  if (flags.file) note = fs.readFileSync(flags.file, "utf8");
  if (note == null || note === true) fail("нужен --html '<...>' или --file PATH");
  const c = client();
  await updateTask(c, { id, note });
  process.stdout.write(`note обновлена для ${id} (${String(note).length} символов)\n`);
}

async function cmdCreate(flags) {
  if (!flags.title || flags.title === true) fail("usage: sing create --title '...' [--project ID] [--tags A,B] [--note '...']");
  const c = client();
  const task = { title: String(flags.title) };
  if (flags.project && flags.project !== true) {
    const pm = await projectMaps(c);
    task.projectId = resolveProject(flags.project, pm); // принимает P-id ИЛИ имя (fail-fast, как move)
    // Привязать к секции проекта — иначе новая задача осиротеет (выпадет в «без проекта»).
    const targetGroup = defaultGroupId(await getGroups(c), task.projectId);
    if (targetGroup) task.group = targetGroup;
  }
  if (flags.note && flags.note !== true) task.note = String(flags.note);
  if (flags.tags) {
    const tm = await tagMaps(c);
    task.tags = flagList(flags.tags).map((n) => tm.nameToId.get(n) || n);
  }
  const resp = await c.createTask(task);
  const created = resp && resp.task ? resp.task : resp;
  process.stdout.write(`создана задача ${created.id || "(id?)"}: ${name(created) || task.title}\n`);
}

// done = закрыть + убрать из активных (батч; id из аргументов или stdin). Идемпотентно.
async function cmdDone(positional) {
  const c = client();
  const ids = resolveIds(positional);
  await runBatch(ids, async (id) => {
    const before = await getTaskIncludingRemoved(c, id);
    if (isDone(before)) { process.stdout.write(`done ${id} "${name(before) || ""}" — уже done\n`); return; }
    await updateTask(c, { id, ...DONE_PATCH() });
    const after = await getTaskIncludingRemoved(c, id);
    const mark = isDone(after) ? "" : " ⚠ не подтверждено";
    process.stdout.write(`done ${id} "${name(after) || name(before) || ""}" → complete=${after.complete || 0} deleteDate=${after.deleteDate ? "set" : "—"}${mark}\n`);
  });
}

// rename — переписать заголовок (монки-формат). Заголовок = весь хвост positional (кавычки в shell необязательны).
async function cmdRename(positional) {
  const id = positional[0];
  const title = positional.slice(1).join(" ").trim();
  if (!id || !title) fail('usage: sing rename <id> "новое название"');
  const c = client();
  const before = await c.getTask(id);
  await updateTask(c, { id, title });
  const after = await c.getTask(id);
  process.stdout.write(`rename ${id}\n  было:  ${before.title || "—"}\n  стало: ${after.title || "—"}\n`);
}

// move — сменить проект (батч). --project принимает P-id или имя.
// Всегда привязывает задачу к секции целевого проекта (--section по имени, иначе дефолтная fake-
// секция) — иначе задача осиротеет (group от старого проекта невалиден → выпадет в «без проекта»).
async function cmdMove(positional, flags) {
  if (!flags.project || flags.project === true) fail("usage: sing move <id...> --project ID|имя [--section NAME]");
  const c = client();
  const ids = resolveIds(positional);
  const [pm, groups] = await Promise.all([projectMaps(c), getGroups(c)]);
  const projectId = resolveProject(flags.project, pm); // fail-fast до записи, если проект неизвестен
  let targetGroup = defaultGroupId(groups, projectId);
  if (flags.section && flags.section !== true) {
    const wanted = String(flags.section);
    const sec = groups.find((g) => g.parent === projectId && name(g) === wanted);
    if (!sec) fail(`секция «${wanted}» не найдена в проекте ${projectId}`);
    targetGroup = sec.id;
  }
  await runBatch(ids, async (id) => {
    const before = await c.getTask(id);
    const patch = { id, projectId };
    if (targetGroup) patch.group = targetGroup; // не осиротить: привязать к секции целевого проекта
    await updateTask(c, patch);
    const after = await c.getTask(id);
    const from = pm.idToName.get(before.projectId) || before.projectId || "Входящие";
    const to = pm.idToName.get(after.projectId) || after.projectId;
    const sect = targetGroup ? ` [секция ${after.group === targetGroup ? "ok" : "⚠"}]` : " [секций нет]";
    process.stdout.write(`move ${id} "${name(after) || ""}": ${from} → ${to}${sect}\n`);
  });
}

// heal-groups — привязать задачи-сироты (group=null или битая ссылка) к дефолтной секции их проекта,
// чтобы они перестали выпадать в «без проекта». --dry только показывает; --project ограничивает.
async function cmdHealGroups(flags) {
  const c = client();
  const [tasks, groups, pm] = await Promise.all([getTasks(c, {}), getGroups(c), projectMaps(c)]);
  const validByProject = groupsByProject(groups);
  let orphans = tasks.filter(isActive).filter((t) => needsGroupHeal(t, validByProject));
  if (flags.project && flags.project !== true) {
    const pid = resolveProject(flags.project, pm);
    orphans = orphans.filter((t) => t.projectId === pid);
  }
  if (!orphans.length) { process.stdout.write("heal-groups: задач-сирот не найдено ✓\n"); return; }
  if (flags.dry) {
    process.stdout.write(`heal-groups --dry: ${orphans.length} задач-сирот (ничего не пишу):\n`);
    for (const t of orphans) {
      const proj = pm.idToName.get(t.projectId) || t.projectId;
      const target = defaultGroupId(groups, t.projectId);
      process.stdout.write(`  ${t.id} "${(t.title || "").slice(0, 45)}" — ${proj} → ${target || "нет секции ⚠"}\n`);
    }
    process.stdout.write(`итого сирот: ${orphans.length}\n`);
    return;
  }
  await runBatch(orphans.map((t) => t.id), async (id) => {
    const before = await c.getTask(id);
    const target = defaultGroupId(groups, before.projectId);
    if (!target) { process.stdout.write(`heal ${id} "${name(before) || ""}" — у проекта нет секций, пропуск\n`); return; }
    await updateTask(c, { id, group: target });
    const after = await c.getTask(id);
    const mark = after.group === target ? "ok" : "⚠ не подтверждено";
    process.stdout.write(`heal ${id} "${name(after) || ""}": group → ${target} [${mark}]\n`);
  });
}

// bucket — коробочка дат (батч). today/tomorrow=start в GMT+3; week=deferred; none=снять обе.
async function cmdBucket(positional, flags) {
  const modes = ["today", "tomorrow", "week", "none"].filter((m) => flags[m]);
  if (modes.length !== 1) fail("usage: sing bucket <id...> --today|--tomorrow|--week|--none (ровно один флаг)");
  const mode = modes[0];
  const c = client();
  const ids = resolveIds(positional);
  await runBatch(ids, async (id) => {
    const before = await c.getTask(id);
    let patch;
    if (mode === "today") patch = { id, start: todayGMT3Iso(), deferred: false };
    else if (mode === "tomorrow") patch = { id, start: tomorrowGMT3Iso(), deferred: false };
    else if (mode === "week") patch = { id, start: null, deferred: true };
    else patch = { id, start: null, deferred: false }; // none — снять start через null (см. спайк)
    await updateTask(c, patch);
    const after = await c.getTask(id);
    const fmt = (t) => `start=${t.start || "—"} deferred=${Boolean(t.deferred)}`;
    process.stdout.write(`bucket ${id} (${mode}): ${fmt(before)} → ${fmt(after)}\n`);
  });
}

// archive — убрать из активных без отметки «выполнено» (разбор stale-задач, батч). Идемпотентно.
async function cmdArchive(positional) {
  const c = client();
  const ids = resolveIds(positional);
  await runBatch(ids, async (id) => {
    const before = await getTaskIncludingRemoved(c, id);
    if (isArchived(before)) { process.stdout.write(`archive ${id} "${name(before) || ""}" — уже archived\n`); return; }
    await updateTask(c, { id, ...ARCHIVE_PATCH() });
    const after = await getTaskIncludingRemoved(c, id);
    const mark = after.deleteDate ? "set" : "⚠ не подтверждено";
    process.stdout.write(`archive ${id} "${name(after) || ""}" → deleteDate=${mark}\n`);
  });
}

// checklist — прочитать или синхронизировать шаги задачи.
async function cmdChecklist(positional, flags) {
  const id = positional[0];
  if (!id) fail('usage: sing checklist <id> --add "шаг"|--list|--delete ITEM_ID|--replace-file FILE');
  const operations = ["add", "list", "delete", "replace-file"].filter((key) => flags[key] != null);
  if (operations.length !== 1) fail("для checklist нужен ровно один режим: --add, --list, --delete или --replace-file");
  const c = client();
  const list = async () => asArray(await c.listChecklistItems({ parent: id }), "checklistItems")
    .slice().sort((a, b) => (a.parentOrder || 0) - (b.parentOrder || 0));

  if (flags.list) {
    const items = await list();
    for (const item of items) {
      process.stdout.write(JSON.stringify({ id: item.id, title: item.title, checked: Boolean(item.checked) }) + "\n");
    }
    return;
  }

  if (flags.add != null) {
    if (flags.add === true) fail('нужен --add "текст шага"');
    const title = String(flags.add);
    await c.createChecklistItem({ parent: id, title });
    const items = await list();
    process.stdout.write(`checklist ${id}: добавлен "${title}" (всего пунктов: ${items.length})\n`);
    return;
  }

  if (flags.delete != null) {
    if (flags.delete === true) fail("нужен --delete ITEM_ID");
    const itemId = String(flags.delete);
    const before = await list();
    const item = before.find((x) => x.id === itemId);
    if (!item) fail(`пункт ${itemId} не найден в задаче ${id}`);
    await c.deleteChecklistItem(itemId);
    const after = await list();
    if (after.some((x) => x.id === itemId)) fail(`удаление ${itemId} не подтверждено`);
    process.stdout.write(`checklist ${id}: удалён "${item.title}" (осталось: ${after.length})\n`);
    return;
  }

  if (flags["replace-file"] === true) fail("нужен --replace-file FILE");
  const file = String(flags["replace-file"]);
  const titles = checklistTitlesFromText(fs.readFileSync(file, "utf8"));
  if (!titles.length) fail("файл чек-листа пуст; для очистки удаляй пункты явно через --delete");
  const available = await list();
  for (let i = 0; i < titles.length; i++) {
    const index = available.findIndex((item) => item.title === titles[i]);
    let item;
    if (index >= 0) item = available.splice(index, 1)[0];
    else {
      const created = await c.createChecklistItem({ parent: id, title: titles[i] });
      item = created.checklistItem || created;
    }
    await c.updateChecklistItem({ id: item.id, parentOrder: (i + 1) * 100 });
  }
  for (const item of available) await c.deleteChecklistItem(item.id);
  const after = await list();
  if (JSON.stringify(after.map((item) => item.title)) !== JSON.stringify(titles)) {
    fail("замена чек-листа не подтверждена перечиткой");
  }
  process.stdout.write(`checklist ${id}: синхронизировано ${after.length} пунктов из ${file}\n`);
}

// deadline — проставить дедлайн (GMT+3).
async function cmdDeadline(positional, flags) {
  const id = positional[0];
  if (!id) fail("usage: sing deadline <id> --date YYYY-MM-DD");
  const iso = dateToGMT3Iso(flags.date);
  if (!iso) fail("нужен --date в формате YYYY-MM-DD");
  const c = client();
  const before = await c.getTask(id);
  await updateTask(c, { id, deadline: iso });
  const after = await c.getTask(id);
  process.stdout.write(`deadline ${id} "${name(after) || ""}": ${before.deadline || "—"} → ${after.deadline}\n`);
}

// project-rename — переписать имя проекта (по P-id или текущему имени). rename меняет имя, не ID.
async function cmdProjectRename(positional) {
  const ref = positional[0];
  const newName = positional.slice(1).join(" ").trim();
  if (!ref || !newName) fail('usage: sing project-rename <id|имя> "новое имя"');
  const c = client();
  const pm = await projectMaps(c);
  const id = resolveProject(ref, pm); // fail-fast до записи, если проект неизвестен
  const before = pm.idToName.get(id) || id;
  await c.updateProject({ id, title: newName }); // у проекта поле заголовка — title (не name)
  const after = await c.getProject(id); // верификация перечиткой
  process.stdout.write(`project-rename ${id}\n  было:  ${before}\n  стало: ${name(after) || newName}\n`);
}

// project-create — создать проект (опц. под родителем по P-id или имени). С верификацией-эхом.
async function cmdProjectCreate(flags) {
  if (!flags.title || flags.title === true) fail("usage: sing project-create --title '...' [--parent ID|имя]");
  const c = client();
  const project = { title: String(flags.title) }; // у проекта поле заголовка — title (не name)
  if (flags.parent && flags.parent !== true) {
    const pm = await projectMaps(c);
    project.parent = resolveProject(flags.parent, pm);
  }
  const resp = await c.createProject(project);
  const created = resp && (resp.project || resp.data) ? (resp.project || resp.data) : resp;
  let line = `создан проект ${created.id || "(id?)"}: ${name(created) || project.name}`;
  if (created.id) {
    const after = await c.getProject(created.id); // верификация: подтверждаем имя и родителя
    if (after && after.parent) line += ` · parent=${after.parent}`;
  }
  process.stdout.write(line + "\n");
}

function usage() {
  process.stdout.write(`sing — компактный CLI поверх Singularity API

Чтение (в stdout только проекция нужных полей; --out FILE кладёт сырой дамп для jq):
  sing tasks [--project ID] [--tag NAME] [--query TEXT] [--no-reference] [--active] [--candidate]
             [--deferred true|false] [--inbox] [--due today|overdue] [--done|--all]
             [--format jsonl|tsv|count|json] [--fields a,b,c] [--tag-ids] [--out FILE]
             # --inbox = истинные Входящие: без проекта И без даты (start/deferred) — канонная выборка на разбор
             # --due = срочность по локальному дню GMT+3: today (start/deadline в окне сегодня),
             #         overdue (start/deadline в прошлом). Можно вместе: --due today,overdue (фокус §8)
  sing task <id> [--json]
  sing projects [--format ...] [--out FILE]
  sing tags
  sing metrics [--json] [--done|--all]   # total/reference/deferred/active + backpressure review/research

Запись (каждая делает верификацию-эхо перечиткой, не вываливает полный объект):
  sing tag-swap <id> --add NAME --remove NAME   # атомарный свап + верификация
  sing note <id> (--html '...' | --file PATH)   # DECISION-BRIEF в заметку
  sing create --title '...' [--project ID] [--tags A,B] [--note '...']
  sing done <id...>                             # закрыть + убрать из активных (complete+deleteDate); идемпотентно
  sing rename <id> "новое название"             # переписать заголовок (монки-формат)
  sing move <id...> --project ID|имя [--section NAME]  # сменить проект (+ привязать к секции; дефолт — не осиротить)
  sing heal-groups [--project ID|имя] [--dry]   # привязать сирот (group=null/битая) к дефолтной секции проекта
  sing bucket <id...> --today|--tomorrow|--week|--none  # коробочка дат в GMT+3
  sing archive <id...>                          # убрать из активных без «выполнено» (разбор stale)
  sing checklist <id> --add "шаг"|--list|--delete ITEM_ID|--replace-file FILE
  sing deadline <id> --date YYYY-MM-DD          # дедлайн (GMT+3)
  sing project-rename <id|имя> "новое имя"      # переименовать проект (меняет имя, не ID)
  sing project-create --title '...' [--parent ID|имя]  # создать проект (опц. под родителем)

Батч: id для done/move/bucket/archive — аргументами ИЛИ через stdin (whitespace/newline);
частичный сбой не прерывает остальные. По умолчанию tasks/metrics скрывают выполненные/архивные
(--done или --all — показать).

Фильтры: --active = не reference и не deferred; --candidate = active без тегов Waiting/Мозгоштурм
(структурный кандидат «что делать дальше»; сам next-action оценивает агент по компактному списку).

Reference-проекты настраиваются под аккаунт через env (по умолчанию пусто):
  SINGULARITY_REFERENCE_SPHERE=P-…             # id проекта-сферы; всё под ней — reference
  SINGULARITY_REFERENCE_PROJECTS=P-…,P-…        # либо явный список id через запятую
`);
}

// --------------------------- main ---------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  // Падать на неизвестном флаге (а не молча игнорировать — иначе агент строит выборку на мусоре).
  if (KNOWN_FLAGS[cmd]) {
    const bad = unknownFlags(cmd, flags);
    if (bad.length) fail(`неизвестный флаг: ${bad.map((f) => "--" + f).join(", ")} (sing help)`);
  }
  switch (cmd) {
    case "tasks": return cmdTasks(flags);
    case "task": return cmdTask(positional, flags);
    case "projects": return cmdProjects(flags);
    case "tags": return cmdTags(flags);
    case "metrics": return cmdMetrics(flags);
    case "tag-swap": return cmdTagSwap(positional, flags);
    case "note": return cmdNote(positional, flags);
    case "create": return cmdCreate(flags);
    case "done": return cmdDone(positional);
    case "rename": return cmdRename(positional);
    case "move": return cmdMove(positional, flags);
    case "heal-groups": return cmdHealGroups(flags);
    case "bucket": return cmdBucket(positional, flags);
    case "archive": return cmdArchive(positional);
    case "checklist": return cmdChecklist(positional, flags);
    case "deadline": return cmdDeadline(positional, flags);
    case "project-rename": return cmdProjectRename(positional);
    case "project-create": return cmdProjectCreate(flags);
    case undefined:
    case "help":
    case "--help":
    case "-h": return usage();
    default: fail(`неизвестная команда: ${cmd} (sing help)`);
  }
}

// Экспорт чистых хелперов для bin/sing.test.js; CLI запускается только при прямом вызове.
if (require.main === module) {
  main().catch((err) => {
    const msg = err && err.response ? `HTTP ${err.response.status} ${err.response.statusText || ""}`.trim() : (err && err.message) || String(err);
    fail(msg);
  });
} else {
  module.exports = {
    nowIso, DONE_PATCH, ARCHIVE_PATCH, isArchived, isDone, isActive,
    dateToGMT3Iso, todayGMT3Iso, tomorrowGMT3Iso, dueClasses, todayWindowGMT3, resolveProject, resolveProjectSafe,
    parseArgs, flagList, KNOWN_FLAGS, unknownFlags, referenceProjectIds, referenceConfig,
    defaultGroupId, groupsByProject, needsGroupHeal, isInboxTask,
    reviewGuardReason, authFromArgs, findCodexSingularityArgs, taskMatchesQuery, checklistTitlesFromText,
    taskUpdateRequest, isNotFound,
  };
}
