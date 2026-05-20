# infra/

Infrastructure for the public deploy. Topology:

```text
Internet --443--> nginx (LAN, SSL edge)
                 -> caddy.lan:8080 (app host)
                    -> serves /srv/telescope/ static bundle
                    -> proxies /api/* and /ws/* to pi.lan:8000
```

## Files

| Path | Purpose |
|------|---------|
| [`nginx/telescope.conf`](nginx/telescope.conf) | Public SSL terminator. Installed once and proxies every path to Caddy. |
| [`caddy/Caddyfile.live`](caddy/Caddyfile.live) | Serves the SPA from `dist/` and reverse-proxies `/api/*` and `/ws/*` to the Pi. |
| [`systemd/radiotelescope.service`](systemd/radiotelescope.service) | Pi-side systemd unit. |
| [`secrets.example.env`](secrets.example.env) | Template for production secrets. Never commit the real file. |
| [`deploy.env`](deploy.env) | Host parameters for the deploy script. |

The deploy script lives at [`../scripts/deploy.sh`](../scripts/deploy.sh).

## One-time bootstrap

### nginx host

```bash
sudo cp infra/nginx/telescope.conf /etc/nginx/sites-available/telescope.conf
sudo ln -sf /etc/nginx/sites-available/telescope.conf /etc/nginx/sites-enabled/telescope.conf
sudo certbot --nginx -d telescope.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Edit `telescope.conf`: replace `telescope.example.com` with the real
hostname and `caddy.lan:8080` with the LAN address Caddy listens on.

### caddy host

```bash
sudo mkdir -p /srv/telescope /var/log/caddy
sudo chown -R caddy:caddy /srv/telescope /var/log/caddy
sudo cp infra/caddy/Caddyfile.live /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Edit the `bind` directive in the Caddyfile to the caddy host's LAN IP.

### Pi (backend)

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin telescope
sudo install -d -o telescope -g telescope /opt/radiotelescope /var/log/radiotelescope /var/lib/radiotelescope /etc/radiotelescope
sudo -u telescope python -m venv /opt/radiotelescope/venv
sudo -u telescope /opt/radiotelescope/venv/bin/pip install --upgrade pip
sudo -u telescope /opt/radiotelescope/venv/bin/pip install /path/to/checkout

sudo cp /path/to/checkout/config.example.toml /etc/radiotelescope/config.toml
sudo chown root:telescope /etc/radiotelescope/config.toml
sudo chmod 0640 /etc/radiotelescope/config.toml

sudo cp infra/secrets.example.env /etc/radiotelescope/secrets.env
sudo chown root:telescope /etc/radiotelescope/secrets.env
sudo chmod 0640 /etc/radiotelescope/secrets.env
python -c "import secrets; print(secrets.token_urlsafe(48))"

sudo cp infra/systemd/radiotelescope.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable radiotelescope.service
```

The backend's `public_exposure_errors()` startup gate refuses to come up
with placeholder secrets, so a misconfigured deploy fails loudly rather
than serving with `change-me` cookies.

For beta-only access, enable `[auth]` and provide `passwords.txt`. With auth
enabled, the queue page can load and submit `/api/queue/join`, but other API
and WebSocket endpoints require the signed auth cookie set by a successful
beta-password join.

## Deploy

Set hosts in [`deploy.env`](deploy.env):

```env
CADDY_HOST=caddy.lan
PI_HOST=pi.lan
CADDY_WEBROOT=/srv/telescope
```

Then run:

```bash
./scripts/deploy.sh
```

The script builds `frontend/dist/`, syncs it to the Caddy webroot, installs
`Caddyfile.live`, reloads Caddy, and restarts `radiotelescope.service`.
