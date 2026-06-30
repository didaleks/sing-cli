# sing

Компактный, самодостаточный CLI поверх [Singularity](https://singularity-app.com) API — задуман как
**лёгкая альтернатива MCP-серверу** для работы агентов (Claude Code и т.п.) с задачами.

## Зачем

MCP-сервер на чтении возвращает **полные объекты**: `listTasks` — это сотни задач целиком в JSON, что
мгновенно жжёт контекст агента. `sing` ходит в тот же API live, но печатает в stdout **только
компактную проекцию** нужных полей (или метрики). Сырой полный дамп выгружается опционально в файл
(`--out`) для `jq`, не в контекст.

Команды записи (`done`/`rename`/`move`/`bucket`/`archive`/`note`/`create` …) делают
**верификацию-эхо**: после записи перечитывают задачу и печатают «было → стало», не вываливая полный
объект.

Итог: чтение, метрики и циклы — через `sing`; MCP остаётся запасным путём для операций без CLI-обёртки.

## Установка

```sh
git clone <repo> sing && cd sing
npm install                       # единственная внешняя зависимость — axios@1.10.0
./sing help                       # список команд и флагов
```

Требуется Node ≥ 18 (нужен полный ICU для `Intl` с таймзоной `Europe/Moscow` — расчёт GMT+3).

## Аутентификация

Токен берётся из переменных окружения (и **никогда** не печатается):

```sh
export SINGULARITY_ACCESS_TOKEN=…           # обязательно
export SINGULARITY_BASE_URL=https://api.singularity-app.com   # опц., это и есть дефолт
```

Если запущен официальный MCP-сервер Singularity, как фолбэк токен/URL подхватываются из
`~/.claude.json` (аргументы запуска `mcpServers.singularity`).

## Быстрый старт

```sh
./sing tasks --format count        # сколько активных задач
./sing tasks --candidate           # компактный список кандидатов «что делать»
./sing metrics                     # метрики нагрузки + backpressure
./sing done T-123 T-456            # закрыть пачкой (с верификацией)
./sing tasks --out tmp/all.json    # сырой дамп в файл для jq (не в контекст)
```

## Настройка reference-проектов (опционально)

«Reference» — пользовательская семантика «справочных» проектов (библиотека/архив, а не активные
задачи). В Singularity этой пометки нет, поэтому она настраивается через env (по умолчанию **пусто** —
никакой проект не reference):

```sh
export SINGULARITY_REFERENCE_SPHERE=P-…           # id проекта-сферы; всё под ней — reference
# либо явный список:
export SINGULARITY_REFERENCE_PROJECTS=P-…,P-…
```

Влияет на фильтры `--no-reference`/`--active`/`--candidate` и на метрику `reference`.

## Документация

- **[AGENTS.md](AGENTS.md)** — полный справочник команд и канон правил API (источник правды; написан
  так, чтобы агент разобрался без чтения других репозиториев).
- **[docs/STRUCTURE.md](docs/STRUCTURE.md)** — карта файлов и поток вызовов.
- **[.claude/skills/sing/SKILL.md](.claude/skills/sing/SKILL.md)** — skill: как агенту работать с `sing`
  вместо MCP.

## Лицензия

[MIT](LICENSE). Файлы `client.js` и `utils/auth.js` вендорятся без изменений из официального
`singularity-mcp-server` (тоже MIT) — см. раздел Third-party в [LICENSE](LICENSE).
