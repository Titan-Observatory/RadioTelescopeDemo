# ── goestools build stage ──────────────────────────────────────────────────
# goesrecv/goesproc (GOES observation mode) aren't packaged for Debian; build
# them from source. Vendored submodules (nanomsg, libcorrect) come with the
# recursive clone.
FROM debian:bookworm-slim AS goestools
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates build-essential cmake zlib1g-dev \
        libusb-1.0-0-dev libairspy-dev librtlsdr-dev libopencv-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --recursive https://github.com/pietern/goestools /src \
    && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /build -j"$(nproc)" \
    && cmake --install /build --prefix /opt/goestools \
    # Some revisions don't install share/; keep the COPY below unconditional.
    && mkdir -p /opt/goestools/share /opt/goestools/bin

FROM python:3.11-slim

# SoapySDR + Airspy driver and GNU Radio (with gr-soapy) come from apt; their
# Python bindings aren't on PyPI. GNU Radio is required for the spectrum
# pipeline subprocess (rt_hardware.sdr_pipeline) which does the FFT in C++
# rather than Python. The OpenCV/airspy/rtlsdr runtime libs also serve the
# goestools binaries copied in below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        airspy \
        librtlsdr0 \
        rtl-sdr \
        libopencv-core406 libopencv-imgproc406 libopencv-imgcodecs406 \
        python3-soapysdr \
        soapysdr-tools \
        soapysdr-module-airspy \
        soapysdr-module-rtlsdr \
        libsoapysdr0.8 \
        gnuradio \
        gr-soapy \
        python3-zmq \
    && rm -rf /var/lib/apt/lists/*

# goesrecv + goesproc and their example configs (goesproc handler discovery
# looks under /usr/local/share/goestools).
COPY --from=goestools /opt/goestools/bin/ /usr/local/bin/
COPY --from=goestools /opt/goestools/share/ /usr/local/share/

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
