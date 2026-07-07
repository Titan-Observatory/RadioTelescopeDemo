# infra/

Infrastructure for the public bare-metal deploy. Topology:

```text
Internet --443--> upstream SSL terminator (Cloudflare or similar)
                 -> nginx (LAN, plain HTTP forward)
                    -> caddy.lan:8080 (platform host)
                       -> serves platform/frontend/dist/ static bundle
                       -> proxies /api/* and /ws/* to rt-platform:8000 (same host)
                                                ↓
                                  rt-hardware:8001 (Pi, LAN-only)
```

The platform service runs on the public host alongside Caddy and proxies to the Pi over the LAN. The Pi exposes the hardware service only to that one host's IP (firewall / LAN-only bind).

For the all-in-one alternative, see the repo-root `docker-compose.yml` — same wiring, but both containers live on one host with the hardware container unreachable from the outside.

## Files

| Path | Purpose |
|------|---------|
| [`caddy/Caddyfile.live`](caddy/Caddyfile.live) | Serves the SPA bundle and reverse-proxies `/api/*` and `/ws/*` to the platform service. |
| [`systemd/rt-hardware.service`](systemd/rt-hardware.service) | Pi-side unit for `rt-hardware`. |
| [`systemd/rt-platform.service`](systemd/rt-platform.service) | Platform-host unit for `rt-platform`. |
| [`secrets.example.env`](secrets.example.env) | Template for production secrets (platform only). Never commit the real file. |
| [`deploy.env`](deploy.env) | Host parameters for the deploy script. |

The deploy script lives at [`../deploy.sh`](../deploy.sh) and now drives `docker compose up -d --build`. For systemd-based deployments, treat the steps below as the one-time bootstrap and use `systemctl restart rt-hardware rt-platform` on subsequent rolls.

## One-time bootstrap

### Pi (hardware service)

```bash
# system deps
sudo apt install -y airspy soapysdr-tools soapysdr-module-airspy python3-soapysdr
sudo useradd --system --create-home --shell /usr/sbin/nologin telescope
sudo usermod -aG dialout,plugdev,video telescope

sudo install -d -o telescope -g telescope \
    /opt/radiotelescope/checkout \
    /opt/radiotelescope/hardware \
    /var/log/radiotelescope \
    /var/lib/radiotelescope \
    /etc/radiotelescope

# install
sudo -u telescope git clone https://github.com/Titan-Observatory/RadioTelescopeDemo.git /opt/radiotelescope/checkout
sudo -u telescope python3 -m venv --system-site-packages /opt/radiotelescope/hardware/.venv
sudo -u telescope /opt/radiotelescope/hardware/.venv/bin/pip install --upgrade pip
sudo -u telescope /opt/radiotelescope/hardware/.venv/bin/pip install /opt/radiotelescope/checkout/hardware

# verify the venv can see the apt-installed SoapySDR binding
sudo -u telescope /opt/radiotelescope/hardware/.venv/bin/python -c "import SoapySDR; print(SoapySDR.__file__)"

# verify the OS and SoapySDR can see the Airspy
lsusb | grep -i airspy
SoapySDRUtil --find="driver=airspy"

# config
sudo cp /opt/radiotelescope/checkout/hardware/config.example.toml /etc/radiotelescope/hardware.toml
sudo chown root:telescope /etc/radiotelescope/hardware.toml
sudo chmod 0640 /etc/radiotelescope/hardware.toml
# edit /etc/radiotelescope/hardware.toml: observer lat/lon, mount calibration,
# [server] port = 8001 (default), and bind host to the LAN interface if you
# want to belt-and-braces firewall (host = "10.0.0.5" instead of "0.0.0.0").

# systemd
sudo cp /opt/radiotelescope/checkout/infra/systemd/rt-hardware.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rt-hardware.service
sudo systemctl status rt-hardware.service
```

The hardware service is **unauthenticated** by design — protect it at the network layer. Firewall the Pi so only the platform host's IP can reach :8001.

### Platform host

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin telescope
sudo install -d -o telescope -g telescope \
    /opt/radiotelescope/checkout \
    /opt/radiotelescope/platform \
    /var/log/radiotelescope \
    /var/lib/radiotelescope \
    /etc/radiotelescope

# install
sudo -u telescope git clone https://github.com/Titan-Observatory/RadioTelescopeDemo.git /opt/radiotelescope/checkout
sudo -u telescope python3 -m venv /opt/radiotelescope/platform/.venv
sudo -u telescope /opt/radiotelescope/platform/.venv/bin/pip install --upgrade pip
sudo -u telescope /opt/radiotelescope/platform/.venv/bin/pip install /opt/radiotelescope/checkout/platform

# build the frontend (the backend serves frontend/dist/ from /)
cd /opt/radiotelescope/checkout/platform/frontend
sudo -u telescope npm ci
sudo -u telescope npm run build

# config
sudo cp /opt/radiotelescope/checkout/platform/config.example.toml /etc/radiotelescope/platform.toml
sudo chown root:telescope /etc/radiotelescope/platform.toml
sudo chmod 0640 /etc/radiotelescope/platform.toml
# edit /etc/radiotelescope/platform.toml:
#   hardware_url = "http://<pi-ip>:8001"
#   server.cors_origins, server.trusted_proxies, server.lan_only
#   queue.cookie_secret = "${RT_QUEUE_COOKIE_SECRET}"  (from secrets.env)

# secrets
sudo cp /opt/radiotelescope/checkout/infra/secrets.example.env /etc/radiotelescope/secrets.env
sudo chown root:telescope /etc/radiotelescope/secrets.env
sudo chmod 0640 /etc/radiotelescope/secrets.env
# edit /etc/radiotelescope/secrets.env: generate real secrets with
#   python -c "import secrets; print(secrets.token_urlsafe(48))"

# systemd
sudo cp /opt/radiotelescope/checkout/infra/systemd/rt-platform.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rt-platform.service
sudo systemctl status rt-platform.service
```

The platform's `public_exposure_errors()` startup gate refuses to boot with placeholder secrets, wildcard CORS, or missing Turnstile keys whenever `lan_only=false` and the bind is `0.0.0.0`/`::`. A misconfigured deploy fails loudly.

For beta-only access in a systemd deployment, enable `[auth]`, copy the repo
root `passwords.example.txt` to `/etc/radiotelescope/passwords.txt`, replace
the examples, set `auth.passwords_file` to that path, and keep the real file
out of Git. With auth enabled, the queue page can still load and submit
`/api/queue/join`, but other API and WebSocket endpoints require the signed
auth cookie set by a successful beta-password join.

For container deployments, prefer `RT_BETA_PASSWORDS`; the Docker entrypoint
materializes `/app/passwords.txt` inside the container when auth is enabled.

### Caddy host

If Caddy lives on a separate box from the platform, the platform host doesn't need to publish port 8000 externally — only to Caddy. If they're on the same host, leave it bound to localhost:

```bash
sudo mkdir -p /var/log/caddy
sudo cp infra/caddy/Caddyfile.live /etc/caddy/Caddyfile
# edit the Caddyfile: set `bind` to the caddy host's LAN IP, and the
# `reverse_proxy` target to wherever rt-platform is reachable (default:
# http://platform.lan:8000 — change to localhost:8000 if same host).
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy no longer serves the SPA bundle directly — the platform service does. Caddy is purely a TLS terminator + reverse proxy in front of `rt-platform:8000`.

## Deploy

For Docker stacks, `./deploy.sh` at the repo root does `git pull && docker compose up -d --build` on the platform host. For bare-metal systemd deploys, roll each box independently:

```bash
# on the Pi
cd /opt/radiotelescope/checkout && sudo -u telescope git pull
sudo -u telescope /opt/radiotelescope/hardware/.venv/bin/pip install -U /opt/radiotelescope/checkout/hardware
sudo systemctl restart rt-hardware.service

# on the platform host
cd /opt/radiotelescope/checkout && sudo -u telescope git pull
sudo -u telescope /opt/radiotelescope/platform/.venv/bin/pip install -U /opt/radiotelescope/checkout/platform
cd /opt/radiotelescope/checkout/platform/frontend && sudo -u telescope npm ci && sudo -u telescope npm run build
sudo systemctl restart rt-platform.service
```
