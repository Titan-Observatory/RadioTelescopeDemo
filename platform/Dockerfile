# ── Stage 1: build the React frontend ────────────────────────────────────
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


# ── Stage 2: Python runtime ───────────────────────────────────────────────
FROM python:3.11-slim
WORKDIR /app

COPY pyproject.toml ./
COPY src/ src/
RUN pip install --no-cache-dir .

COPY --from=frontend-build /build/dist ./frontend/dist

# Coolify-friendly config: the image ships a config that pulls everything
# from env vars. Coolify injects them via its UI; bind-mounting a TOML is
# not required. For non-Coolify deployments, mount your own config over
# /app/config.toml.
COPY config.docker.toml ./config.toml

# Entrypoint materializes /app/passwords.txt from RT_BETA_PASSWORDS env var
# (newline-separated, base64 OK) and writes default state-file paths on the
# mounted volume before exec'ing rt-platform.
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Persistent state directory. Mount a volume at /app/state in Coolify so
# motion.jsonl / events.jsonl / feedback.jsonl / spectrum_baseline.json
# survive container recreations.
RUN mkdir -p /app/state

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["rt-platform", "-c", "config.toml"]
