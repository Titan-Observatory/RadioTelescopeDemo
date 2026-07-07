# Radio Telescope

A web-based control stack for a remotely operated radio telescope.

This project pairs a browser UI with telescope-side services for mount control,
live telemetry, spectrum viewing, and camera streaming. It is designed around a
platform service and a separate hardware service that stays on the trusted
telescope network.

## What It Does

- Provides a browser dashboard for observing and telescope control
- Supports queue-based access so multiple visitors can watch while one user has control
- Streams live mount telemetry, finder camera video, and SDR spectrum data
- Exposes maintenance-safe platform and hardware APIs
- Keeps the hardware service isolated from the platform's network boundary

## Architecture

The repo is split into two main services:

- `platform/` - web app, API, queue, auth, and proxy layer
- `hardware/` - mount, SDR, and camera control service

The browser talks to the platform. The platform talks to the hardware service
over HTTP and WebSockets.

```text
Browser -> Platform -> Hardware -> Telescope
```

## Quick Start

For a local or single-host demo, copy the example configs and start the
all-in-one Docker stack:

```bash
cp hardware/config.example.toml hardware/config.toml
docker compose up
```

Then open:

```text
http://localhost:8000
```

For development without connected telescope hardware:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

The development override mounts `hardware/config.dev.toml` and
`platform/config.dev.toml`, disables USB pass-through, and lets the hardware
service fall back to simulated/disconnected devices.

## Hardware Service Setup

The hardware service usually runs on the machine attached to the telescope,
such as a Raspberry Pi or small Linux host. It controls the mount, receiver,
and camera, then exposes a local API for the platform service.

Install the OS packages needed by the SDR pipeline:

```bash
sudo apt update
sudo apt install \
  gnuradio gr-soapy python3-soapysdr python3-zmq \
  soapysdr-tools soapysdr-module-airspy soapysdr-module-rtlsdr \
  airspy rtl-sdr
```

Install and configure the service:

```bash
cd hardware
python -m venv .venv --system-site-packages
source .venv/bin/activate
pip install -e ".[dev]"
cp config.example.toml config.toml
```

Edit `config.toml` for your hardware:

- Set the RoboClaw serial port, usually `/dev/ttyACM0` or `/dev/ttyUSB0`.
- Set mount encoder scale and zero offsets before relying on goto commands.
- Set observer location and dish parameters.
- Choose the SDR driver, gain, sample rate, and bias tee setting.
- Choose the camera device if a finder camera is connected.

Give the runtime user access to the serial port:

```bash
sudo usermod -aG dialout $USER
```

Log out and back in after changing groups. Then start the service:

```bash
rt-hardware -c config.toml
```

By default it listens on port `8001`. Keep that port private to the telescope
network and point the platform's `hardware_url` at it.

For a production install, run it under systemd — see
`infra/systemd/rt-hardware.service`, which sets `RT_STATE_DIR` and the required
serial/USB groups for you.

## Local Development

Run the platform service:

```bash
cd platform
pip install -e ".[dev]"
cp config.example.toml config.toml
rt-platform -c config.toml
```

In another terminal, run the frontend dev server:

```bash
cd platform/frontend
npm install
npm run dev
```

The frontend dev server runs on Vite's default port and proxies API calls to
the platform service.

## Configuration

Start from the example config files:

- `hardware/config.example.toml`
- `platform/config.example.toml`
- `platform/config.docker.toml` for container deployments driven by
  environment variables

The platform config points at the hardware service. The hardware config defines
the connected mount, receiver, observer location, and camera settings.

For public deployments:

- Keep the hardware service private to the telescope LAN.
- Generate real queue/auth secrets; never use `change-me-*` placeholders.
- Set explicit CORS origins and trusted proxies.
- Enable Cloudflare Turnstile for public queue joins.
- If beta-password auth is enabled, copy `passwords.example.txt` to
  `passwords.txt`, replace the examples, and keep the real file untracked.

The platform refuses to start in public-exposure mode when required production
secrets or Turnstile keys are still placeholders.

## Deployment Options

- `docker-compose.yml` is the all-in-one convenience stack for a single host.
- `platform/docker-compose.yml` runs only the public platform service, suitable
  for a LAN host or Coolify-style deployment that points at a separate Pi.
- `hardware/docker-compose.yml` runs only the Pi-side hardware service.
- `infra/systemd/` contains bare-metal units for separate platform and hardware
  hosts.

The typical topology is:

```text
TLS/reverse proxy -> rt-platform -> private LAN -> rt-hardware
```

## API Reference

The browser-facing platform API and private hardware API are mapped in
[`docs/api.md`](docs/api.md). The platform is the public edge and applies queue,
control, auth, and LAN-admin gates before proxying trusted hardware routes.

## Security

Public deployment safety notes and vulnerability reporting guidance are in
[`SECURITY.md`](SECURITY.md).

## Testing

```bash
cd platform/frontend
npm run build

cd ../../hardware
pytest

cd ../platform
pytest
```

## Repository Layout

```text
hardware/                Telescope-side service
platform/                Web platform and frontend
docs/                    API and mode-specific documentation
infra/                   Bare-metal deployment support
docker-compose.yml       Main Docker Compose stack
docker-compose.dev.yml   Development override
deploy.sh                Deployment helper
passwords.example.txt    Template for optional beta-password auth
```

## Status

This is active observatory-control software. It is intended for real hardware,
but the development stack can run without attached devices.
