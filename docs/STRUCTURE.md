# Структура проекта `sing`

Навигационный индекс кодовой базы. Это **карта файлов и потока вызовов**, дополняющая два
канонических документа:

- **[../README.md](../README.md)** — быстрый старт.
- **[../AGENTS.md](../AGENTS.md)** — справочник команд и канон правил API (источник правды по поведению).

Не дублирует их: здесь — где что лежит, как команда доходит до API и какую часть `ApiClient` мы реально
используем.

## Карта файлов

| Путь | Роль | Правка вручную |
|---|---|---|
| `sing` | Bash-launcher: находит `sing.js` рядом и `exec node sing.js "$@"`. | да |
| `sing.js` | Вся логика CLI: auth, парсинг argv, хелперы, обработчики команд, dispatch. | да |
| `sing.test.js` | Юнит-тесты чистых хелперов (даты/предикаты/resolveProject), без сети. | да |
| `client.js` | `ApiClient` — HTTP-обёртка над Singularity API. **Копия** из MCP-пакета. | ❌ перекопировать |
| `utils/auth.js` | `createAuthHeader(token)` → `{ Authorization: Bearer … }`. **Копия** из MCP-пакета. | ❌ перекопировать |
| `package.json` | `bin.sing → ./sing.js`, единственная зависимость `axios@1.10.0`, `engines.node ≥ 18`. | да |
| `AGENTS.md` | Канон команд + правил API (база знаний для агентов). | да |
| `README.md` | Быстрый старт. | да |
| `docs/STRUCTURE.md` | Этот файл — структурный индекс. | да |
| `LICENSE` | MIT для проекта + атрибуция вендорённых upstream-файлов. | да |
| `.claude/skills/sing/SKILL.md` | Skill: как агенту работать с `sing` вместо MCP. | да |

`node_modules/` и `tmp/` — в `.gitignore`, не коммитятся.

> ⚠️ `client.js` и `utils/auth.js` помечены `COPIED FROM …` в шапке и **не редактируются вручную** —
> при апдейте MCP-пакета перекопировать (см. [AGENTS.md → Сопровождение](../AGENTS.md#сопровождение)).
> `axios` запиннен на ту же версию, что в MCP-пакете.

## Поток выполнения

```
./sing <cmd> …                         (bash-launcher)
   └─ node sing.js <cmd> …
         main()                        argv[0]=cmd; parseArgs → {positional, flags}
           └─ switch(cmd) → cmdXxx(…)  обработчик команды
                 └─ client()           resolveAuth() → new ApiClient → setAccessToken
                       └─ ApiClient     HTTP в https://api.singularity-app.com
                 └─ proj(…)/emit(…)     компактная проекция в stdout (или --out: сырой дамп в файл)
```

Ключевая идея: в stdout — **только проекция нужных полей** (экономия контекста агента), сырой полный
объект — опционально в файл через `--out`. Команды записи делают **верификацию-эхо** (перечитывают
задачу после записи и печатают «было → стало»).

## Аутентификация (`resolveAuth`, `sing.js`)

1. env `SINGULARITY_ACCESS_TOKEN` (+ опц. `SINGULARITY_BASE_URL`) — если оба заданы, используются.
2. Иначе — парсинг `~/.claude.json`: `findSingularityArgs()` рекурсивно ищет массив args MCP-сервера
   `singularity` и достаёт `--accessToken` / `--baseUrl`.
3. База по умолчанию: `https://api.singularity-app.com`. **Токен никогда не печатается.**

## Команда → обработчик → методы `ApiClient`

| Команда | Обработчик | Вызываемые методы API |
|---|---|---|
| `tasks` | `cmdTasks` | `listTasks`, `listProjects`, `listTags` |
| `task` | `cmdTask` | `getTask`, `listTags` |
| `projects` | `cmdProjects` | `listProjects` |
| `tags` | `cmdTags` | `listTags` |
| `metrics` | `cmdMetrics` | `listTasks`, `listProjects`, `listTags` |
| `tag-swap` | `cmdTagSwap` | `listTags`, `getTask`, `updateTask`, `getTask` (верификация) |
| `note` | `cmdNote` | `updateTask` |
| `create` | `cmdCreate` | `listTags` (если `--tags`), `createTask` |
| `done` | `cmdDone` | `getTask`, локальный PATCH без `id` в теле, `listTasks(includeRemoved)` (верификация); батч |
| `rename` | `cmdRename` | `getTask`, `updateTask`, `getTask` |
| `move` | `cmdMove` | `listProjects`, `getTask`, `updateTask`, `getTask`; батч |
| `bucket` | `cmdBucket` | `getTask`, `updateTask`, `getTask`; батч |
| `archive` | `cmdArchive` | `getTask`, локальный PATCH без `id` в теле, `listTasks(includeRemoved)`; батч |
| `checklist` | `cmdChecklist` | `createChecklistItem`, `listChecklistItems` |
| `deadline` | `cmdDeadline` | `getTask`, `updateTask`, `getTask` |
| `project-rename` | `cmdProjectRename` | `listProjects`, `updateProject`, `getProject` |
| `project-create` | `cmdProjectCreate` | `createProject`, `getProject` (+ `listProjects` если `--parent`) |

Семантику флагов и правила API (GMT+3, «выполнено = архив», коробочки дат, Delta-заметки) см. в
[AGENTS.md → Справочник команд / Правила API](../AGENTS.md#правила-api-канон).

## Чистые хелперы (экспортируются для тестов)

`sing.js` экспортирует через `module.exports` только при `require` (не при запуске как CLI):

| Хелпер | Назначение |
|---|---|
| `dateToGMT3Iso`, `todayGMT3Iso` | День `D` → `(D-1)T21:00:00.000Z` (полночь GMT+3). |
| `isDone`, `isActive`, `isArchived` | Предикаты по `complete` / `deleteDate`. |
| `DONE_PATCH`, `ARCHIVE_PATCH`, `nowIso` | Patch-конструкторы записи. |
| `resolveProject`, `resolveProjectSafe` | `P-…` как есть; иначе имя→id; не найдено → `null`/`fail`. |
| `referenceConfig`, `referenceProjectIds` | Reference-проекты из env (см. ниже); множество reference-id. |
| `parseArgs`, `flagList` | Парсинг argv и списков через запятую. |

**Reference-конфиг.** В коде нет захардкоженных ID аккаунта. «Справочные» проекты задаются через env
`SINGULARITY_REFERENCE_SPHERE` (id сферы — reference считаются все проекты под ней) и/или
`SINGULARITY_REFERENCE_PROJECTS` (явный список id через запятую). По умолчанию пусто → reference-фильтры
(`--no-reference`/`--active`/`--candidate`) и метрика `reference` никого не относят к reference.

Покрыты в `sing.test.js`. Запуск: `npm test` (или `node sing.test.js`) — без сети, требует
установленного `axios`.

## Поверхность `ApiClient` (`client.js`)

`ApiClient` покрывает весь Singularity API; `sing` использует лишь подмножество. Полный набор групп
методов (`list*/get*/create*/update*/delete*`):

| Группа | Методы | Использует `sing` |
|---|---|---|
| Projects | list/get/create/update/delete | ✅ list, get, create, update |
| Tasks | list/get/create/update/delete | ✅ list, get, create, update |
| Tags | list/get/create/update/delete | ✅ list |
| ChecklistItems | list/get/create/update/delete | ✅ list, create |
| Notes | list/get/create/update/delete | — (заметки задач пишутся через `updateTask`) |
| TaskGroups | list/get/create/update/delete | — |
| KanbanStatuses | list/get/create/update/delete | — |
| KanbanTaskStatuses | list/get/create/update/delete | — |
| Habits | list/get/create/update/delete | — |
| HabitDailyProgress | list/get/create/update/delete | — |
| TimeStats | list/get/create/delete (+`deleteBulkTimeStats`) | — |

Операции без CLI-обёртки (привычки, kanban, time-stat, удаление, заметки в Delta) выполняются через
MCP-сервер — см. [AGENTS.md → Что это и зачем](../AGENTS.md#что-это-и-зачем).
