# YouTrack MCP server (for opencode)

MCP-сервер для **JetBrains YouTrack 2022.3** через REST API (`/api`).
Фокус первой версии — **issues и доски (Agile boards)**.

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

## Установка

```bash
pip install -e .
# или просто: pip install fastmcp httpx
```

## Запуск вручную (проверка)

```bash
YOUTRACK_URL=https://youtrack.example.com YOUTRACK_TOKEN=xxx python3 -m youtrack_mcp.server
```

Транспорт — stdio (то, что ожидает opencode).

## Подключение к opencode

Скопируйте `opencode.json.example` в `opencode.json` проекта (или `~/.config/opencode/opencode.json`),
поправьте `cwd` и URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "youtrack": {
      "type": "local",
      "command": ["python3", "-m", "youtrack_mcp.server"],
      "cwd": "/path/to/this/repo",
      "environment": {
        "YOUTRACK_URL": "https://youtrack.yourcompany.com",
        "YOUTRACK_TOKEN": "{env:YOUTRACK_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

## Инструменты (17 шт.)

### Issues
| Инструмент | Описание |
|---|---|
| `yt_search_issues` | Поиск по YouTrack Search Language (`project:ABC State: Unresolved`) |
| `yt_get_issue` | Issue целиком: описание, поля, ссылки, теги |
| `yt_create_issue` | Создание + опциональная команда сразу после создания |
| `yt_update_issue` | Правка subject/description (остальное — командами) |
| `yt_apply_command` | Любая команда из Command Reference (`#State Fixed ABC-1`) |
| `yt_get_comments` / `yt_add_comment` | Комментарии |
| `yt_get_attachments` | Вложения |
| `yt_get_vcs_references` | Ссылки GitLab (MR/commit), пришедшие из интеграции |

### Доски и проекты
| Инструмент | Описание |
|---|---|
| `yt_list_boards` / `yt_get_board` | Agile-доски (`/api/agiles`) |
| `yt_get_board_issues` | Issues на доске (+фильтр) |
| `yt_get_board_columns` | Колонки доски |
| `yt_list_projects` / `yt_get_project_issues` | Проекты и их issues |
| `yt_get_issue_states` | Доступные состояния (пригодится перед `#State ...`) |
| `yt_search_users` | Поиск пользователей (для assignee) |

## Почему изменения статуса — через команды

В YouTrack бизнес-логика живёт в workflow-правилах, которые реагируют именно на
**команды**, а не на прямую запись полей. Поэтому state/priority/tags/assignee
меняются инструментом `yt_apply_command`, а `yt_update_issue` — только для
текстовых полей.

## Тесты

```bash
python3 tests_server.py   # smoke-тест: MCP-handshake + вызовы инструментов на моке API
```

## Структура

```
youtrack_mcp/
  client.py         # async HTTP-клиент (httpx, Bearer-токен)
  tools_issues.py   # инструменты по issues
  tools_boards.py   # инструменты по доскам/проектам
  server.py         # сборка FastMCP-сервера (stdio)
```

## Идеи для следующих шагов

- Sprints: `/api/agiles/{id}/sprints` (старт/завершение спринта)
- Поля по умолчанию при создании issue (тип, подпроект) из настроек проекта
- Attachment download/upload
- Переход на GraphQL для экономии трафика (доступен с 2021.x)
