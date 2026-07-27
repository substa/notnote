FROM python:3.13-slim AS runtime-base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Copy only files served at runtime; repository and development files stay outside the image.
COPY server.py index.html appearance-bootstrap.js app.js graph.js styles.css theme-config.css sw.js ./
COPY manifest.webmanifest ./
COPY docs/ ./docs/
COPY settings/ ./settings/
COPY assets/icons/ ./assets/icons/

EXPOSE 4176

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4176/api/graph/status', timeout=3).read()"]

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "4176", "--graph", "/graph"]

# Default image: smallest runtime, with every editing feature except Git history.
FROM runtime-base AS runtime

# Optional image target for page history and automatic Git snapshots.
FROM runtime-base AS runtime-git
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
