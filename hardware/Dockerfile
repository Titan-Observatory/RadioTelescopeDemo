FROM python:3.11-slim

# SoapySDR + Airspy driver come from apt; the Python bindings aren't on PyPI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3-soapysdr \
        soapysdr-module-airspy \
        libsoapysdr0.8 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY src/ src/
RUN pip install --no-cache-dir .

# Persistent state directory — spectrum_baseline.json lands here. Mount a
# volume at /app/state in compose so the baseline survives container
# recreations.
ENV RT_STATE_DIR=/app/state
RUN mkdir -p /app/state

EXPOSE 8001

CMD ["rt-hardware", "-c", "config.toml"]
