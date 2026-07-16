---
name: sing
description: Работа с задачами Singularity через CLI `sing` — лёгкая альтернатива MCP-серверу. Используй, когда нужно читать/менять задачи, проекты, теги или метрики в Singularity и важно не сжечь контекст полными дампами. Триггеры — "задачи в singularity", "что в трекере", "закрой задачу", "перенеси задачу", "метрики задач", "singularity".
version: 1.0.0
language: ru
---

# sing — задачи Singularity без сжигания контекста

`sing` — тонкий CLI поверх Singularity API. Главный смысл: **MCP отдаёт полные объекты и жжёт
контекст**, а `sing` печатает только компактную проекцию нужных полей. Поэтому для Singularity
**по умолчанию ходи через `sing`, а не через MCP.**

## Шаг 0. Перед работой

1. Убедись, что инструмент доступен: `sing help` (или по абсолютному пути / через `./bin/sing`).
2. Канон команд и правил API — `AGENTS.md` в корне репозитория. При сомнении в поведении (даты,
   «выполнено=архив», коробочки дат, формат заметок) сверяйся с ним, не угадывай.
3. Токен — из env `SINGULARITY_ACCESS_TOKEN`, затем из MCP-конфига Codex или Claude. Никогда не
   печатай токен и не проси пользователя присылать его в чат.

## Главное правило: не тащить полные объекты в контекст

- Для обзора — компактные команды: `sing tasks …`, `sing projects`, `sing tags`, `sing metrics`.
- Нужен полный срез для `jq`/анализа — выгружай в файл, **не в чат**:
  `sing tasks --out tmp/tasks.json`, затем работай с файлом.
- Полный объект одной задачи — только точечно: `sing task <id> --json`.

## Чтение

```sh
sing tasks --format count                 # сколько активных
sing tasks --candidate                    # кандидаты «что делать» (active без Waiting/Мозгоштурм)
sing tasks --project P-… --format tsv      # задачи проекта таблицей
sing tasks --tag review                   # по тегу
sing tasks --query "фрагмент заголовка"    # найти задачу без полного дампа
sing metrics                              # нагрузка + backpressure (review/research)
```

Фильтры: `--active` (не reference, не deferred), `--candidate`, `--inbox`, `--deferred true|false`,
`--no-reference`. По умолчанию выполненные/архивные скрыты (`--done`/`--all` — показать). Проекция полей
настраивается через `--fields a,b,c`; формат — `jsonl` (дефолт) / `tsv` / `count` / `json`.

## Запись (всегда с верификацией-эхо)

Каждая пишущая команда после записи перечитывает объект и печатает «было → стало» — этого достаточно
для подтверждения, не запрашивай полный объект отдельно.

```sh
sing done <id…>                           # закрыть + убрать из активных; батч; идемпотентно
sing move <id…> --project P-…|"Имя"        # сменить проект; батч
sing bucket <id…> --today|--tomorrow|--week|--none  # коробочка дат
sing rename <id> "новое название"
sing deadline <id> --date YYYY-MM-DD
sing tag-swap <id> --add NAME --remove NAME
sing note <id> --html '<p>…</p>'           # заметка (HTML → Delta автоматически)
sing create --title '…' [--project P-…] [--tags A,B]
sing archive <id…>                         # убрать без отметки «выполнено» (stale)
sing checklist <id> --list                 # компактный список пунктов и их ID
sing checklist <id> --delete ITEM_ID       # удалить конкретный пункт
sing checklist <id> --replace-file FILE    # точная синхронизация; `$` и кавычки не трогает shell
```

Батч (`done`/`move`/`bucket`/`archive`): id — аргументами **или** через stdin; частичный сбой не
прерывает остальные, в конце `итого: ok=N fail=N`. Пример пайплайна:

```sh
sing tasks --project P-old --format tsv --fields id | tail -n +2 | sing move --project P-new
```

## Поведение с пользователем

- Перед массовыми изменениями (закрыть/перенести/архивировать пачку) — покажи, что именно затронешь,
  и дождись подтверждения. Не меняй данные молча.
- Reference-проекты (если используются) настраиваются через env
  `SINGULARITY_REFERENCE_SPHERE` / `SINGULARITY_REFERENCE_PROJECTS`; без настройки фильтр reference
  никого не отсеивает.
- Даты — в часовом поясе GMT+3 (CLI пересчитывает сам; передавай `--date YYYY-MM-DD`).

## Когда всё-таки MCP

`sing` покрывает задачи/проекты/теги/чеклисты/метрики. Операции без CLI-обёртки (привычки, kanban,
time-stat, удаление, тонкая работа с заметками в Delta) — через MCP-сервер Singularity.
