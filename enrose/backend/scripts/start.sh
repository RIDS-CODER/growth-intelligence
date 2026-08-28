#!/usr/bin/env sh
# Container entrypoint: migrate, optionally seed, then serve.
set -e

echo "→ Applying database migrations"
alembic upgrade head

# Off by default. Turn on for a first deploy to create the Enrose tenant and the
# owner login; the seed is idempotent, so leaving it on is harmless but noisy.
if [ "${SEED_ON_STARTUP}" = "true" ]; then
  echo "→ Seeding the Enrose Brand Brain"
  python -m app.seed.enrose
fi

echo "→ Starting API on port ${PORT:-8000}"
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips '*'
