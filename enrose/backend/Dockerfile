# Production image for the Enrose autopilot API.
FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# ffmpeg gives the asset pipeline real media probing (duration, dimensions).
# Without it the app records nulls rather than guessing — see integrations/storage.py.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Dependencies first so a code change does not invalidate the layer.
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
COPY scripts ./scripts
RUN chmod +x scripts/start.sh

# Run as a non-root user.
RUN useradd --create-home --uid 10001 enrose \
    && mkdir -p /srv/var/uploads \
    && chown -R enrose:enrose /srv
USER enrose

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:${PORT:-8000}/health || exit 1

CMD ["./scripts/start.sh"]
