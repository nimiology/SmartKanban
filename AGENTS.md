# SmartKanban repository guidance

- For production-server changes, update this repository and deploy from its GitHub checkout; do not edit the server copy directly.
- Production always uses `docker-compose.server.yml`, `server/.env`, Compose project `smartkanban`, and volume `smartkanban_kanban_server_pgdata`.
- Never use bare `docker compose` for production and never run `docker compose down -v`. The root `docker-compose.yml` is for local development only.
- Before an upgrade, confirm the production volume exists. If it is missing, stop and investigate; do not let Compose create an empty replacement. Prefer `scripts/deploy-server.sh` for upgrades.
- The production app listens on host `127.0.0.1:7301`; the local development app uses `127.0.0.1:3001`.
- Report separately what was committed/pushed, what was deployed, and what was verified live. Do not claim server changes are live based on a Git push alone.
