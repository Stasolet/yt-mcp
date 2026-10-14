# YouTrack MCP server (for opencode)

MCP-сервер для **JetBrains YouTrack 2022.3** через REST API (`/api`).
Фокус первой версии — **issues и доски (Agile boards)**.
Написан на **Node.js** и запускается через **npx**.

## Какой API у YouTrack 2022.3

Никакой отдельной «CLI-доки» про GitLab-интеграцию для этого не нужно:

- **REST API** — `https://<youtrack>/api/...` (то, что использует этот сервер).
  Полная спека: `https://<your-youtrack>/rest/docs/` (Swagger прямо на вашем инстансе)
  и https://www.jetbrains.com/help/youtrack/server/2022.3/rest/
- **GraphQL** — `https://<youtrack>/api/graphql` (в этой версии не используется).
- Страница *Command Reference* описывает язык **команд** (`#State Fixed ABC-1`,
  `tag {...} ...`) — это не отдельный транспорт, команды выполняются через тот же
  REST: `POST /api/admin/commands?command=<cmd>` (в сервере — инструмент `yt_apply_command`).
- **Интеграция с GitLab 16.8** к выбору API отношения не имеет: она только
  синхронизирует vcs-ссылки (commits/MR) в issue. Доступ к данным — по-прежнему
  REST API YouTrack; ссылки GitLab видны как `vcs-*` links (инструмент `yt_get_vcs_references`).

## Аутентификация

Сервер использует **permanent token** пользователя YouTrack:

1. В YouTrack: аватар → **Profile & Settings → Applications → Generate Token** (или «Permanent Tokens»).
2. Задать переменные окружения:
   - `YOUTRACK_URL` — базовый URL, например `https://youtrack.example.com`
   - `YOUTRACK_TOKEN` — сгенерированный токен

Токен наследует права пользователя — создайте отдельного service-аккаунт,
если нужны ограниченные права.

## TLS (самоподписанный / внутренний CA)

Node **не использует системное хранилище сертификатов** (в отличие от curl),
поэтому для инстанса с внутренним CA нужно одно из:

- `NODE_EXTRA_CA_CERTS=/path/to/Root-CA.crt` — рекомендуемый вариант:
  проверка сертификата остаётся включена, корневой CA просто добавляется.
  Для youtrack.lab403.inforion.ru это `RnD Root X1`
  (тот же сертификат, что ставится в браузер).
- `YOUTRACK_TLS_INSECURE=1` — отключает проверку сертификата (только для
  доверенных внутренних сетей).

## Реальный API на youtrack.lab403.inforion.ru

Сервер реализует переходную («gaprest») версию REST API, а не документированную
2022.3. Код это учитывает:

- параметр частичного ответа — `fields` (без `$`), пагинация — `$top`;
- сущность issue в legacy-модели: `summary` (не `subject`),
  `numberInProject`, а State/Priority/Type/Assignee/Subsystem — в `customFields`
  (ответы нормализуются к привычному виду);
- команды: `POST /api/commands` телом `{command, query, issues:[{id}]}`,
  цели извлекаются из строки команды и резолвятся отдельно;
- `/api/agiles` существует, но только со списком (`id`, `name`); subresources
  `/agiles/{id}/columns` и `/agiles/{id}/issues` отсутствуют (404). Для задач
  доски используется приближение — поиск по проекту с именем доски;
- создание issue — только с `project.id` (по имени проект не резолвится),
  поэтому `yt_create_issue` сначала ищет проект через `/admin/projects`;
- комментарии: `sortBy` игнорируется, порядок — порядок хранения (старые
  первыми), поэтому `yt_get_comments` сортирует по `created` сам; удаление
  комментария в веб-UI — мягкое: сущность остаётся с пустым `text`,
  `yt_get_comments` такие записи скрывает;
- правка вложенной сущности — `POST` на её собственный путь
  (`POST /api/issues/{id}/comments/{commentId}` с телом `{"text": ...}`
  возвращает 200; `PUT` на тот же путь — 403);
- `DELETE /api/issues/{id}/comments/{commentId}` постоянный токен может
  получать 403, даже когда веб-UI пользователя комментарий удаляет — праву
  удаления комментариев в токене может не хватать полномочия
  (`yt_delete_comment` так и объясняет ошибку).

## Установка

Не требует установки — запуск через `npx` скачает пакет сам:

```bash
# из GitHub (репозиторий: https://github.com/Stasolet/yt-mcp):
npx -y github:Stasolet/yt-mcp
# из npm-реестра (когда пакет будет опубликован):
npx -y youtrack-mcp
# либо из локального клонированного репозитория:
npm install && node bin/cli.js
```

Требуется Node.js >= 18 (используется встроенный `fetch`).

## Запуск вручную (проверка)

```bash
YOUTRACK_URL=https://youtrack.example.com YOUTRACK_TOKEN=xxx npx -y youtrack-mcp
```

Транспорт — stdio (то, что ожидает opencode).

## Подключение к opencode

Скопируйте `opencode.json.example` в `opencode.json` проекта (или `~/.config/opencode/opencode.json`),
поправьте URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "youtrack": {
      "type": "local",
      "command": ["npx", "-y", "github:Stasolet/yt-mcp"],
      "environment": {
        "YOUTRACK_URL": "https://youtrack.yourcompany.com",
        "YOUTRACK_TOKEN": "{env:YOUTRACK_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

## Инструменты (21 шт.)

### Issues
| Инструмент | Описание |
|---|---|
| `yt_search_issues` | Поиск по YouTrack Search Language (`project:ABC State: Unresolved`); baseline-поля всегда домешиваются в `fields` |
| `yt_get_issue` | Issue целиком: описание, поля, ссылки, теги |
| `yt_create_issue` | Создание + опциональная команда; при ошибке команды issue всё равно возвращается с полем `command_error` |
| `yt_update_issue` | Правка subject/description (остальное — командами); `expected_updated` защищает от перезаписи параллельной правки |
| `yt_apply_command` | Любая команда из Command Reference (`#State Fixed ABC-1`) |
| `yt_get_comments` | Комментарии, новые сначала; отдают `id` (нужен для правки/удаления), автора, `created`; `count`/`skip` — пагинация |
| `yt_add_comment` | Новый комментарий; текст сохраняется как wiki-разметка **как есть** (бэктики — inline-code, экранировать слешем их не нужно) |
| `yt_update_comment` | Замена текста комментария по `comment_id` |
| `yt_delete_comment` | Удаление комментария; при 403 подсказывает, что токену не выдано право удаления |
| `yt_get_attachments` | Вложения |
| `yt_get_vcs_references` | Ссылки GitLab (MR/commit), пришедшие из интеграции |

### Доски и проекты
| Инструмент | Описание |
|---|---|
| `yt_list_boards` / `yt_get_board` | Agile-доски (`/api/agiles`) |
| `yt_get_board_issues` | Issues на доске (+фильтр) |
| `yt_get_board_columns` | Колонки доски |
| `yt_list_projects` / `yt_get_project_issues` | Проекты и их issues |
| `yt_get_issue_states` | Доступные состояния (обёртка над `yt_get_project_fields` для поля State) |
| `yt_search_users` | Поиск пользователей (для assignee) |

### Метаданные и raw-доступ
| Инструмент | Описание |
|---|---|
| `yt_get_project_fields` | Кастомные поля проекта и допустимые значения бандлов (Subsystem/Priority/...); проверять перед командами |
| `yt_rest_get` | Read-only GET произвольного `/api/...` эндпоинта с параметрами (только чтение) |

## Рекомендации по командам

- Значения полей с одним словом пишутся **без фигурных скобок**: `#Subsystem Backend`,
  а не `#Subsystem {Backend}` (инстанс отвечает 400 `Subsystem expected: {Backend}`);
  сервер сам делает одну повторную попытку без скобок. Скобки остаются нужны для
  многословных значений, например тегов: `tag {GitLab merge request} ABC-1`.
- Точные допустимые значения поля — в `yt_get_project_fields`.
- `yt_apply_command` возвращает `isError`, если YouTrack ответил непустым полем
  `error` (HTTP при этом может быть 200).

## Почему изменения статуса — через команды

В YouTrack бизнес-логика живёт в workflow-правилах, которые реагируют именно на
**команды**, а не на прямую запись полей. Поэтому state/priority/tags/assignee
меняются инструментом `yt_apply_command`, а `yt_update_issue` — только для
текстовых полей.

## Тесты

```bash
npm test   # smoke-тест: MCP-handshake + вызовы инструментов на моке API
```

## Структура

```
bin/cli.js            # точка входа для npx youtrack-mcp
src/
  client.js           # HTTP-клиент (глобальный fetch, Bearer-токен)
  tools-issues.js     # инструменты по issues
  tools-boards.js     # инструменты по доскам/проектам
  tools-meta.js       # поля проекта + read-only raw GET
  server.js           # сборка MCP-сервера (@modelcontextprotocol/sdk, stdio)
tests/server.test.js  # smoke-тест
```

## Идеи для следующих шагов

- Sprints: `/api/agiles/{id}/sprints` (старт/завершение спринта)
- Поля по умолчанию при создании issue (тип, подпроект) из настроек проекта
- Attachment download/upload
- Переход на GraphQL для экономии трафика (доступен с 2021.x)

## Скачать YAML-спеку REST API с вашего инстанса

```bash
./fetch_api_spec.sh https://youtrack.yourcompany.com [permanent-token]
# токен можно не подставлять в команду — возьмётся из $YOUTRACK_TOKEN или спросит интерактивно
```

Скрипт пробует `/rest/docs/swagger.yaml`, `/api/rest/docs/swagger.yaml`,
`/app/rest/docs/swagger.yaml` и сохраняет удавшийся вариант в
`youtrack-api-spec.yaml`. Если ни один путь не подошёл — откройте
`<url>/rest/docs/` в браузере, в DevTools → Network найдите запрос к
`swagger.yaml`/`swagger.json` (или клик «Download JSON/YAML» на странице Swagger UI)
и пришлите этот файл.
