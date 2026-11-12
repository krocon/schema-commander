#!/bin/sh
# Throwaway database servers for the ignored integration tests (src-tauri/tests/db_integration.rs):
# PostgreSQL 17, MySQL 8.4, MariaDB 11.4 and SQL Server 2022 in Docker – and, for the servers that speak
# PostgreSQL's protocol (prompt 035), CockroachDB 24.3 (insecure, single node) and TimescaleDB on PostgreSQL 17 –,
# each on 127.0.0.1 only, with a test password and nothing kept. After log-commander's scripts/db-test-servers.sh.
#
#   sh scripts/db-test-servers.sh up      # starts the containers, waits until all answer
#   pnpm rust:test:db                     # runs the tests against them
#   sh scripts/db-test-servers.sh down    # removes the containers
#
# SQL Server runs as linux/amd64 (emulated on Apple Silicon, about 30 s to start).
# Oracle (prompt 035b): Oracle Database Free, service FREEPDB1, user SHOP – a large image (about 6 GB),
# native on Apple Silicon. `up` starts it with the others; SC_DBTEST_ORACLE=0 leaves it out.
set -eu
pw="Sc-test-003!"

case "${1:-}" in
up)
  docker run -d --rm --name sc-dbtest-pg -p 127.0.0.1:25432:5432 -e POSTGRES_PASSWORD="$pw" \
    postgres:17-alpine >/dev/null
  docker run -d --rm --name sc-dbtest-my -p 127.0.0.1:23306:3306 -e MYSQL_ROOT_PASSWORD="$pw" \
    -e MYSQL_DATABASE=shop mysql:8.4 >/dev/null
  docker run -d --rm --name sc-dbtest-maria -p 127.0.0.1:23307:3306 -e MARIADB_ROOT_PASSWORD="$pw" \
    -e MARIADB_DATABASE=shop mariadb:11.4 >/dev/null
  docker run -d --rm --name sc-dbtest-ms --platform linux/amd64 -p 127.0.0.1:21433:1433 -e ACCEPT_EULA=Y \
    -e MSSQL_SA_PASSWORD="$pw" mcr.microsoft.com/mssql/server:2022-latest >/dev/null
  docker run -d --rm --name sc-dbtest-crdb -p 127.0.0.1:25434:26257 cockroachdb/cockroach:latest-v24.3 \
    start-single-node --insecure >/dev/null
  docker run -d --rm --name sc-dbtest-tsdb -p 127.0.0.1:25433:5432 -e POSTGRES_PASSWORD="$pw" \
    timescale/timescaledb:latest-pg17 >/dev/null
  want=6
  if [ "${SC_DBTEST_ORACLE:-1}" != "0" ]; then
    docker run -d --rm --name sc-dbtest-ora -p 127.0.0.1:21521:1521 -e ORACLE_PASSWORD="$pw" \
      -e APP_USER=shop -e APP_USER_PASSWORD="$pw" gvenzl/oracle-free:23-slim-faststart >/dev/null
    want=7
  fi
  printf "waiting for the servers"
  for _ in $(seq 1 120); do
    ok=0
    docker exec sc-dbtest-pg pg_isready -q -U postgres 2>/dev/null && ok=$((ok + 1))
    docker exec sc-dbtest-my mysqladmin ping -uroot -p"$pw" --silent 2>/dev/null | grep -q alive && ok=$((ok + 1))
    docker exec sc-dbtest-maria healthcheck.sh --connect 2>/dev/null && ok=$((ok + 1))
    docker logs sc-dbtest-ms 2>&1 | grep -q "Recovery is complete" && ok=$((ok + 1))
    docker exec sc-dbtest-crdb cockroach sql --insecure -e "select 1" >/dev/null 2>&1 && ok=$((ok + 1))
    docker exec sc-dbtest-tsdb pg_isready -q -U postgres 2>/dev/null && ok=$((ok + 1))
    if [ "$want" -eq 7 ]; then
      docker logs sc-dbtest-ora 2>&1 | grep -q "DATABASE IS READY TO USE" && ok=$((ok + 1))
    fi
    [ "$ok" -eq "$want" ] && { echo " ready"; exit 0; }
    printf "."
    sleep 2
  done
  echo " not all servers came up" >&2
  exit 1
  ;;
down)
  docker rm -f sc-dbtest-pg sc-dbtest-my sc-dbtest-maria sc-dbtest-ms sc-dbtest-crdb sc-dbtest-tsdb \
    sc-dbtest-ora \
    >/dev/null 2>&1 || true
  ;;
*)
  echo "usage: $0 up|down" >&2
  exit 2
  ;;
esac
