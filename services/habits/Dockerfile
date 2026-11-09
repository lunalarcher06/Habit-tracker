# syntax=docker/dockerfile:1
# habits service. Build context is services/habits/ (see docker-compose.yml).
FROM python:3.12-slim

# GIT_SHA is passed in by compose / the pipeline and shown by /health as "version"
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA \
    PORT=8001 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first, so editing source files does not reinstall them
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Only what the app needs to run (no tests, no .env, no local databases)
COPY app.py auth.py service.py ./
COPY db/ ./db/
COPY migrations/ ./migrations/

# Run as a normal user, not root
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8001

# Asks the service's own /health endpoint (200 = healthy)
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ['PORT'] + '/health')" || exit 1

CMD ["python", "app.py"]
