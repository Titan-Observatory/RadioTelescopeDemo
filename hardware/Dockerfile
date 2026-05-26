FROM python:3.11-slim

# SoapySDR + Airspy driver and GNU Radio (with gr-soapy) come from apt; their
# Python bindings aren't on PyPI. GNU Radio is required for the spectrum
# pipeline subprocess (rt_hardware.sdr_pipeline) which does the FFT in C++
# rather than Python — see CLAUDE.md.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        airspy \
        python3-soapysdr \
        soapysdr-tools \
        soapysdr-module-airspy \
        libsoapysdr0.8 \
        gnuradio \
        gr-soapy \
        python3-zmq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `python3-soapysdr` installs the bindings into Debian's system dist-packages,
# while the official Python image runs `/usr/local/bin/python`.
ENV PYTHONPATH=/usr/lib/python3/dist-packages

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
