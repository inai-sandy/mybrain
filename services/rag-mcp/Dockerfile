FROM python:3.12-slim

# System deps for asyncpg + general health
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install uv for fast dependency management
RUN pip install --no-cache-dir uv

# Copy project files
COPY pyproject.toml ./
COPY src/ ./src/

# Install dependencies into system Python (no venv inside container)
RUN uv pip install --system --no-cache .

# Default port (can be overridden via PORT env var)
EXPOSE 8050

# Healthcheck — server should respond to GET /sse
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8050}/sse -m 3 || exit 1

CMD ["python", "src/main.py"]
