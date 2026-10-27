# Связи задач: документация против шлюза youtrack.lab403.inforion.ru

Связи между задачами — штатный функционал YouTrack 2023.3. На этом инстансе
часть документированных способов работает, часть переходный («gaprest») шлюз
не пропускает. Всё в таблице проверено live 2026-10-23 на задачах MDPO.

Официальная документация JetBrains:

- [Managing links between issues (2023.3)](https://www.jetbrains.com/help/youtrack/server/2023.3/link-issues.html#search-linked-issues) —
  создание в UI, поиск связанных задач;
- [Link types (2023.3)](https://www.jetbrains.com/help/youtrack/server/2023.3/link-types.html) —
  типы связей и их направления;
- [Manage links between issues (DevPortal)](https://www.jetbrains.com/help/youtrack/devportal/api-howto-link-issues.html) —
  REST-создание связей в новых версиях YouTrack; наш инстанс этого API не
  отдаёт.

## Что проверено на этом инстансе

| Способ (по докам) | Ожидаемый результат | Факт на инстансе |
|---|---|---|
| Команда `#Relates to <ЦЕЛЬ>` (`POST /api/commands`, `query` хранит id цели, `issues` — источник) | связь создана | **работает**: связь появляется у обеих задач (проверено `relates to:` поиском в обе стороны). Форма `{"command":"#Relates to MDPO-25","query":"Relates to MDPO-25","issues":[{"id":"<источник>"}]}` |
| Распознавание прочих link-глаголов (`query` с несуществующим id) | — | распознаются и доходят до резолва id (`issue id expected`): `Subtask of`, `Duplicates`, `Is duplicated by`, `Depends on`, `Is required for`. Не являются командами (`Unknown command`): `Parent`, `Child`, `Has subtask`, `Has child`, `Duplicate of`, `Required by`, `Blocked by`, `Depend`, `Duplicate` без `s`. End-to-end (с созданием связи) проверено только на `Relates to` |
| Команды `link <тип> ...` | связь создана | `Unknown command: link …` для любого синтаксиса; `runCommand` отсекает такие команды на клиенте, не обращаясь к API |
| Снятие связи `-` (`#Relates to -X`, `#-Relates to X`, `#-relates to X`) | связь удалена | парсер шлюза отвергает (`issue id expected: -X`, `Unknown command: -`); **удаление связей — только веб-UI** |
| `GET /api/issues/{id}/links` | список связей с целями | для любой задачи ровно 7 заглушек (`104-0…104-3t`) без name/цели; поля `name`, `count`, `srcIssue`, `dstIssue` шлюз срезает |
| `POST/PUT/DELETE /api/issues/{id}/links…`, `PATCH` задачи с `links` | изменение связей | `405 Method Not Allowed` (для PATCH — требование полного тела задачи, links не принимает) |
| `GET /api/issueLinkTypes` | список типов связей | **работает**: `Relates`, `Depend`, `Duplicate`, `Subtask`; `forwardedName`/`reverseName` шлюз срезает (`yt_list_link_types`) |
| Поиск `<link name>: <id>` из доков | связанные задачи | **работает и читает связи**: `relates to: MDPO-25` → MDPO-100 и обратно. Атрибут `links to:` отвечает несогласованно (иногда возвращает саму запрошенную задачу) — его не использовать |
| `POST /api/issues/{id}/commands?query=…` | исполнение команды над задачей | `404` — подмаршрута нет |
| `POST /api/commands/execute`, `/api/graphql` | альтернативные исполнители | `404` |
| Legacy REST (`/rest/issue`) | управление связями | «Deprecated REST API is disabled» |
| Веб-UI YouTrack | создание, просмотр и удаление связей | работает |

## Побочные находки про команды (тоже проверено live)

- Парсер шлюза **проглатывает хвост команды в значение поля**: в `query`
  нельзя оставлять id обычных команд (`State Foo ABC-1` валидируется как
  значение `Foo ABC-1`) — `runCommand` вырезает id для не-link команд и
  сохраняет id цели только для link-формы.
- `tag <текст>` **создаёт** тег с именем `<текст>`, даже несуществующий;
  `tag -Тег` создаёт тег с литеральным именем `-Тег` вместо снятия.
  Снятие тега — только REST: `DELETE /api/issues/{id}/tags/{tagId}`
  (инструмент `yt_remove_tag`), сущность тега остаётся в бандле.
- Хвост с фигурными скобками (`tag -{Feature Bug}`) создаёт тег
  `-{Feature Bug}` — снятие множественных тегов командой невозможно.
- Кавычки вокруг link-глагола в поиске молча меняют семантику (проверено
  live 2026-10-26): `subtask of: MDPO-82` возвращает подзадачи MDPO-82,
  `"subtask of": MDPO-82` — саму задачу MDPO-82. Ошибки при этом нет.
  Link-атрибуты никогда не квотировать:

  | Форма запроса | Возвращает |
  |---|---|
  | `subtask of: MDPO-82` | подзадачи MDPO-82 |
  | `parent for: MDPO-82` | родителя MDPO-82 |
  | `"subtask of": MDPO-82` | саму задачу MDPO-82 |

## Что делать агенту

1. Создать связь: `yt_apply_command` со строкой вида
   `#Relates to <ЦЕЛЬ> <ЗАДАЧА> [<ЗАДАЧА>…]` — id сразу после фразы является
   целью связи, остальные — задачи, на которых связь создаётся. End-to-end
   проверено на `#Relates to` (в том числе повторное применение идемпотентно);
   для прочих глаголов проверено только распознавание шлюзом. Несколько
   источников в одной команде проверены только стендом, не live.
2. Прочитать связи: поиск `relates to: <id>` — проверенный канал, работает в
   обе стороны. Для прочих типов имя атрибута не проверено, а пустой ответ
   поиска ничего не доказывает (парсер не отличает неизвестный атрибут от
   отсутствия связей). Атрибут `links to:` отвечает несогласованно — не
   использовать.
3. Удалить связь: только человек в веб-UI (Remove link у задачи).
4. Снять тег: `yt_remove_tag`, не команда `tag -…`.
