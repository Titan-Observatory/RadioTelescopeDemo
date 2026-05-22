# ── Stage 1: build the React frontend ────────────────────────────────────────
#
# We use a Node.js image just for the build step. The output (frontend/dist/)
# is copied into the final image; none of Node or node_modules travels with it.

FROM node:20-slim AS frontend-build

WORKDIR /build

# Copy package files first so Docker can cache the npm install layer.
# If you only change React source files (not package.json), this layer is
# reused and the build is much faster on repeat runs.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Now copy the rest of the frontend source and compile it.
COPY frontend/ ./
RUN npm run build


# ── Stage 2: Python runtime ───────────────────────────────────────────────────
#
# This is the image that actually runs. It starts from a slim Python base,
# installs the Python package, and pulls in the compiled frontend from Stage 1.

FROM python:3.11-slim

WORKDIR /app

# Install the Python package and its dependencies.
# We copy pyproject.toml + src/ (the package source) but NOT dev tools or tests.
COPY pyproject.toml README.md ./
COPY src/ src/
RUN pip install --no-cache-dir .

# Pull the compiled frontend out of Stage 1 and place it where the backend
# expects to find it (it searches for frontend/dist/index.html relative to CWD).
COPY --from=frontend-build /build/dist ./frontend/dist

# Copy the Docker-specific config template. This file uses ${VAR} placeholders
# that the app replaces at startup from environment variables you set in Coolify.
COPY config.docker.toml ./config.toml

# Entrypoint script: writes passwords.txt from RT_BETA_PASSWORDS env var if set,
# then hands off to the main command below.
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# The app listens on port 8000 by default.
EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["radiotelescope", "-c", "config.toml"]
