#!/usr/bin/env bash
# Safely update the production server without ever falling back to the dev DB.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose --project-name smartkanban --project-directory "$ROOT" \
  --env-file "$ROOT/server/.env" -f "$ROOT/docker-compose.server.yml")

[[ -f server/.env ]] || { echo "Missing server/.env" >&2; exit 1; }
grep -q '^KANBAN_DB_PASSWORD=.' server/.env || {
  echo "KANBAN_DB_PASSWORD is missing from server/.env; refusing deployment" >&2
  exit 1
}
docker volume inspect smartkanban_kanban_server_pgdata >/dev/null 2>&1 || {
  echo "Expected database volume smartkanban_kanban_server_pgdata is missing; refusing to create an empty database" >&2
  exit 1
}
[[ "$(git branch --show-current)" == main ]] || {
  echo "Production deploy must run from the main branch" >&2
  exit 1
}
[[ -z "$(git status --porcelain)" ]] || {
  echo "Working tree has local changes; commit or preserve them before deploying" >&2
  exit 1
}

git pull --ff-only origin main
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up -d db
db_ready=false
for _ in {1..30}; do
  if "${COMPOSE[@]}" exec -T db pg_isready -U kanban -d kanban >/dev/null 2>&1; then
    db_ready=true
    break
  fi
  sleep 2
done
[[ "$db_ready" == true ]] || { echo "Production database did not become ready" >&2; exit 1; }

for migration in server/migrations/*.sql; do
  [[ -f "$migration" ]] || continue
  "${COMPOSE[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U kanban -d kanban < "$migration"
done
"${COMPOSE[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U kanban -d kanban < server/schema.sql
"${COMPOSE[@]}" up -d --build db server

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:7301/health; then
    echo
    echo "SmartKanban production deploy completed."
    exit 0
  fi
  sleep 2
done

echo "Server did not become healthy. Recent logs:" >&2
"${COMPOSE[@]}" logs --tail=100 server >&2
exit 1
