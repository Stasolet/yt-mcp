#!/usr/bin/env bash
# Скачать YAML-спеку REST API (Swagger 2.0) с локального инстанса YouTrack 2022.3.
#
# Использование:
#   ./fetch_api_spec.sh https://youtrack.yourcompany.com [токен]
#
# Токен: Profile & Settings -> Applications -> Generate Token (в самом YouTrack).
# Если токен не передать вторым аргументом, возьмётся из $YOUTRACK_TOKEN
# или будет запрошен интерактивно (без эха).
set -euo pipefail

YT_URL="${1:?Usage: $0 <youtrack-base-url> [token]}"
TOKEN="${2:-${YOUTRACK_TOKEN:-}}"

if [[ -z "$TOKEN" ]]; then
  read -rsp "YouTrack permanent token (input hidden): " TOKEN; echo >&2
fi

# Отрезаем хвостовые /api и / — на случай если вставили URL из адресной строки
YT_URL="${YT_URL%/}"
YT_URL="${YT_URL%/api}"

AUTH_HEADER=(-H "Authorization: Bearer ${TOKEN}")
# На старых инстансах/настройках токен может ожидаться как query-параметр:
QUERY_PARAM="oauth_consumer_key=${TOKEN}"

for path in \
  "/rest/docs/swagger.yaml" \
  "/api/rest/docs/swagger.yaml" \
  "/app/rest/docs/swagger.yaml"
do
  url="${YT_URL}${path}"
  out="youtrack-api-spec$([[ "$path" == *swagger.json ]] && echo .json || echo .yaml)"
  echo ">> Trying: ${url}" >&2
  code=$(curl -sSL --max-time 60 "${AUTH_HEADER[@]}" \
    -w '%{http_code}' -o "$out" "${url}?${QUERY_PARAM}" || true)
  head -c 200 "$out" >&2 || true; echo >&2
  if [[ "$code" == "200" ]] && grep -qE 'swagger:|openapi:' "$out"; then
    echo "== OK: saved to $(pwd)/$out" >&2
    exit 0
  fi
done

echo "!! Не удалось получить YAML по известным путям." >&2
echo "   Откройте в браузере ${YT_URL}/rest/docs/ и найдите в DevTools (Network)" >&2
echo "   запрос к swagger.yaml / swagger.json — пришлите мне этот файл." >&2
rm -f youtrack-api-spec.yaml youtrack-api-spec.json
exit 1
