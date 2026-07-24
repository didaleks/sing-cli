#!/usr/bin/env node
"use strict";
/**
 * Лёгкие ассерты на чистые хелперы sing.js (без сети). Запуск: `node sing.test.js` (или `npm test`).
 * Сетевые команды проверяются E2E против живого API.
 */

const h = require("./sing.js"); // экспортируется только при require (не при запуске как CLI)

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}\n  ожидалось: ${e}\n  получено:  ${a}`); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); } }

// --- auth config ---
const codexConfig = `
[mcp_servers.singularity]
command = "node"
args = ["/tmp/singularity/mcp.js", "--baseUrl", "https://api.example.test", "--accessToken", "secret-token", "-n"]

[mcp_servers.other]
command = "other"
`;
const codexArgs = h.findCodexSingularityArgs(codexConfig);
eq(codexArgs, ["/tmp/singularity/mcp.js", "--baseUrl", "https://api.example.test", "--accessToken", "secret-token", "-n"],
  "findCodexSingularityArgs: читает args нужной MCP-секции");
eq(h.authFromArgs(codexArgs, null, null), { baseUrl: "https://api.example.test", token: "secret-token" },
  "authFromArgs: извлекает URL и токен");
eq(h.authFromArgs(codexArgs, "https://env.test", "env-token"), { baseUrl: "https://env.test", token: "env-token" },
  "authFromArgs: env имеет приоритет");
ok(h.findCodexSingularityArgs("[mcp_servers.other]\ncommand = \"x\"") === null,
  "findCodexSingularityArgs: отсутствующая секция → null");

// --- даты GMT+3 ---
// День D в GMT+3 хранится как (D-1)T21:00:00.000Z.
eq(h.dateToGMT3Iso("2026-06-30"), "2026-06-29T21:00:00.000Z", "dateToGMT3Iso 2026-06-30");
eq(h.dateToGMT3Iso("2026-01-01"), "2025-12-31T21:00:00.000Z", "dateToGMT3Iso рубеж года");
ok(/^\d{4}-\d{2}-\d{2}T21:00:00\.000Z$/.test(h.todayGMT3Iso()), "todayGMT3Iso формат полночи GMT+3");
ok(h.dateToGMT3Iso("плохая дата") === null, "dateToGMT3Iso невалидный формат → null");
eq(h.tomorrowGMT3Iso("2026-07-15T21:00:00.000Z"), "2026-07-16T21:00:00.000Z", "tomorrowGMT3Iso +1 локальный день");

// --- поиск и безопасный текст чек-листа ---
ok(h.taskMatchesQuery({ title: "Сравнить Bybit и IDpay" }, "bybit"), "taskMatchesQuery: регистронезависимый поиск");
ok(!h.taskMatchesQuery({ title: "Купить USD" }, "AMD"), "taskMatchesQuery: несовпадающий заголовок");
eq(h.checklistTitlesFromText("Первый шаг\n\n  Отложить $3–4 тыс.  \r\n"), ["Первый шаг", "Отложить $3–4 тыс."],
  "checklistTitlesFromText: строки из файла без shell-интерполяции");

// --- предикаты ---
ok(h.isDone({ complete: 1 }) === true, "isDone complete:1");
ok(h.isDone({ deleteDate: "2026-06-19T00:00:00.000Z" }) === true, "isDone deleteDate");
ok(h.isDone({ state: 1 }) === false, "isDone обычная активная (state:1) → false");
ok(h.isDone({}) === false, "isDone пустая → false");
ok(h.isActive({ state: 1 }) === true, "isActive активная");
ok(h.isActive({ complete: 1 }) === false, "isActive выполненная → false");
ok(h.isArchived({ deleteDate: "x" }) === true, "isArchived deleteDate");
ok(h.isArchived({ complete: 1 }) === false, "isArchived complete без deleteDate → false");

// --- resolveProject ---
const pm = { nameToId: new Map([["Проект А", "P-aaaa0001"]]), idToName: new Map() };
eq(h.resolveProject("P-aaaa0001", pm), "P-aaaa0001", "resolveProject принимает P-id как есть");
eq(h.resolveProject("Проект А", pm), "P-aaaa0001", "resolveProject имя→id");
ok(h.resolveProjectSafe("Несуществующий", pm) === null, "resolveProjectSafe мусор → null");

// --- referenceProjectIds (настраиваемый reference-конфиг) ---
const projs = [{ id: "P-sphere" }, { id: "P-child", parent: "P-sphere" }, { id: "P-other" }];
const refBySphere = h.referenceProjectIds(projs, { sphere: "P-sphere", fallback: [] });
ok(refBySphere.has("P-sphere") && refBySphere.has("P-child") && !refBySphere.has("P-other"),
  "referenceProjectIds: сфера и её потомки → reference, прочее → нет");
const refByList = h.referenceProjectIds(projs, { sphere: null, fallback: ["P-other"] });
ok(refByList.has("P-other") && !refByList.has("P-sphere"),
  "referenceProjectIds: при пустой сфере — только явный список");
ok(h.referenceProjectIds(projs, { sphere: null, fallback: [] }).size === 0,
  "referenceProjectIds: нейтральный дефолт (ничего не задано) → пусто");

// --- defaultGroupId (дефолтная секция проекта) ---
// У каждого проекта есть ровно одна fake-группа (дефолтная псевдо-секция). Плюс могут быть
// реальные именованные секции. Задача без валидной группы падает в «без проекта».
const grps = [
  { id: "Q-fakeA", parent: "P-a", fake: true, parentOrder: 0 },
  { id: "Q-secA1", parent: "P-a", title: "Заказать", parentOrder: 50 },
  { id: "Q-secA2", parent: "P-a", title: "Жду", parentOrder: 125 },
  { id: "Q-fakeB", parent: "P-b", fake: true },
  { id: "Q-secC1", parent: "P-c", title: "Только реальная", parentOrder: 30 },
];
eq(h.defaultGroupId(grps, "P-a"), "Q-fakeA", "defaultGroupId: fake-группа при наличии секций");
eq(h.defaultGroupId(grps, "P-b"), "Q-fakeB", "defaultGroupId: единственная fake-группа");
eq(h.defaultGroupId(grps, "P-c"), "Q-secC1", "defaultGroupId: fallback на верхнюю секцию, если fake нет");
ok(h.defaultGroupId(grps, "P-unknown") === null, "defaultGroupId: нет групп проекта → null");

// --- needsGroupHeal (задача-сирота внутри проекта: group=null или битая ссылка) ---
const validByProj = new Map([
  ["P-a", new Set(["Q-fakeA", "Q-secA1", "Q-secA2"])],
  ["P-b", new Set(["Q-fakeB"])],
]);
ok(h.needsGroupHeal({ projectId: "P-a", group: null }, validByProj) === true, "needsGroupHeal: group=null → чинить");
ok(h.needsGroupHeal({ projectId: "P-a", group: "Q-deleted" }, validByProj) === true, "needsGroupHeal: битая ссылка на удалённую секцию → чинить");
ok(h.needsGroupHeal({ projectId: "P-a", group: "Q-secA1" }, validByProj) === false, "needsGroupHeal: валидная секция → не трогать");
ok(h.needsGroupHeal({ projectId: "P-b", group: "Q-fakeB" }, validByProj) === false, "needsGroupHeal: fake-группа валидна → не трогать");
ok(h.needsGroupHeal({ projectId: null, group: null }, validByProj) === false, "needsGroupHeal: задача без проекта — не наш случай (не чинить группой)");
ok(h.needsGroupHeal({ projectId: "P-unknown", group: null }, validByProj) === false, "needsGroupHeal: проект без известных групп → не чинить (нечем)");

// --- isInboxTask (истинный инбокс: без проекта И без коробочки-даты) ---
// Владелец ловит задачи «без проекта и без даты» — они по умолчанию падают в инбокс. Как только
// задаче назначили проект ИЛИ дату (start/deferred) — она разобрана и из инбокса уходит.
ok(h.isInboxTask({ projectId: null, start: null, deferred: null }) === true, "isInboxTask: без проекта и даты → да");
ok(h.isInboxTask({ projectId: "", start: null, deferred: false }) === true, "isInboxTask: пустой projectId → да");
ok(h.isInboxTask({ projectId: "P-a", start: null, deferred: null }) === false, "isInboxTask: есть проект → нет");
ok(h.isInboxTask({ projectId: null, start: "2026-07-05T21:00:00.000Z", deferred: false }) === false, "isInboxTask: есть start (запланирована) → нет");
ok(h.isInboxTask({ projectId: null, start: null, deferred: true }) === false, "isInboxTask: deferred (когда-нибудь) → нет");

// --- reviewGuardReason (нельзя ставить review без брифа в заметке §12) ---
// Свап на review без непустого note теряет бриф — задача уходит «на ревью» пустой.
// Guard блокирует это (кроме --force). Note-ref "N-T-…" = бриф есть; "" = пусто.
ok(h.reviewGuardReason({ note: "" }, ["review"], false), "reviewGuardReason: пустая заметка + review → блок");
ok(h.reviewGuardReason({ note: "   \n " }, ["review"], false), "reviewGuardReason: whitespace-заметка + review → блок");
ok(h.reviewGuardReason({}, ["review"], false), "reviewGuardReason: note отсутствует + review → блок");
ok(h.reviewGuardReason({ note: "N-T-abc" }, ["review"], false) === null, "reviewGuardReason: note-ref (бриф есть) → пропуск");
ok(h.reviewGuardReason({ note: "" }, ["research"], false) === null, "reviewGuardReason: не review в --add → пропуск");
ok(h.reviewGuardReason({ note: "" }, [], false) === null, "reviewGuardReason: ничего не добавляем → пропуск");
ok(h.reviewGuardReason({ note: "" }, ["review"], true) === null, "reviewGuardReason: --force снимает блок");

// --- dueClasses (срочность по локальному дню GMT+3) ---
// Окно «сегодня» D: [lower, upper) = [(D-1)T21:00Z, D·T21:00Z). Смотрим start И deadline.
const dcLower = "2026-07-10T21:00:00.000Z"; // 00:00 11.07 local
const dcUpper = "2026-07-11T21:00:00.000Z"; // 00:00 12.07 local
ok(h.dueClasses({ start: "2026-07-10T21:00:00.000Z" }, dcLower, dcUpper).has("today"), "dueClasses: start ровно сегодня → today");
ok(h.dueClasses({ start: "2026-07-03T21:00:00.000Z" }, dcLower, dcUpper).has("overdue"), "dueClasses: start в прошлом → overdue");
ok(h.dueClasses({ deadline: "2026-07-05T21:00:00.000Z" }, dcLower, dcUpper).has("overdue"), "dueClasses: deadline в прошлом → overdue");
ok(h.dueClasses({ start: "2026-07-11T21:00:00.000Z" }, dcLower, dcUpper).size === 0, "dueClasses: start завтра (=upper) → ни today, ни overdue");
ok(h.dueClasses({ start: null, deadline: null }, dcLower, dcUpper).size === 0, "dueClasses: без дат → пусто");
const dcBoth = h.dueClasses({ start: "2026-07-03T21:00:00.000Z", deadline: "2026-07-10T21:00:00.000Z" }, dcLower, dcUpper);
ok(dcBoth.has("overdue") && dcBoth.has("today"), "dueClasses: overdue start + today deadline → оба класса");

// --- unknownFlags (ошибка на неизвестный флаг) ---
eq(h.unknownFlags("tasks", { due: "today", project: "P-x", query: "Bybit" }), [], "unknownFlags: валидные флаги tasks → пусто");
eq(h.unknownFlags("tasks", { today: true }), ["today"], "unknownFlags: --today не флаг tasks → ошибка");
eq(h.unknownFlags("bucket", { today: true }), [], "unknownFlags: --today валиден для bucket");
eq(h.unknownFlags("bucket", { tomorrow: true }), [], "unknownFlags: --tomorrow валиден для bucket");
eq(h.unknownFlags("checklist", { list: true }), [], "unknownFlags: --list валиден для checklist");
eq(h.unknownFlags("checklist", { "replace-file": "steps.txt" }), [], "unknownFlags: --replace-file валиден для checklist");
eq(h.unknownFlags("tasks", { bogus: true, x: 1 }).sort(), ["bogus", "x"], "unknownFlags: собирает все неизвестные");
eq(h.unknownFlags("help", { whatever: true }), [], "unknownFlags: неизвестная команда здесь не валидируется → пусто");

// --- patch-конструкторы ---
const dp = h.DONE_PATCH();
ok(dp.complete === 1 && dp.completeLast === undefined && typeof dp.deleteDate === "string",
  "DONE_PATCH отправляет только разрешённые API поля");
const ap = h.ARCHIVE_PATCH();
ok(ap.deleteDate && ap.complete === undefined, "ARCHIVE_PATCH только deleteDate, без complete");
eq(h.taskUpdateRequest({ id: "T-123", title: "Новый заголовок", start: null }),
  { id: "T-123", data: { title: "Новый заголовок", start: null } },
  "taskUpdateRequest: id остаётся в URL и не попадает в PATCH-тело");
ok(h.isNotFound({ response: { status: 404 } }), "isNotFound: HTTP 404");
ok(!h.isNotFound({ response: { status: 400 } }), "isNotFound: прочая ошибка");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
