# infra/

Infrastructure for the public deploy. Topology:

```
Internet ──443──▶ nginx (LAN, SSL edge)
                  └── proxies → caddy.lan:8080 (app host)
                                  ├── serves /srv/telescope/  (static bundle)
                                  └── (live mode) proxies /api+/ws → pi.lan:8000
```

## Files

| Path | Purpose |
|------|---------|
| [`nginx/telescope.conf`](nginx/telescope.conf) | Public SSL terminator. **Mode-agnostic** — installed once, never swapped. |
| [`caddy/Caddyfile.pre-launch`](caddy/Caddyfile.pre-launch) | Caddy in pre-launch mode: static `dist-static/` only, `/api/*` and `/ws/*` 404. |
| [`caddy/Caddyfile.live`](caddy/Caddyfile.live) | Caddy in live mode: static `dist/` + reverse proxy to Pi for `/api/*` and `/ws/*`. |
| [`systemd/radiotelescope.service`](systemd/radiotelescope.service) | Pi-side systemd unit. |
| [`secrets.example.env`](secrets.example.env) | Template for production secrets. **Never commit the real file.** |
| [`deploy.env`](deploy.env) | The deploy-mode switch (`DEPLOY_MODE=pre-launch` or `live`) plus host params. |

The deploy script lives at [`../scripts/deploy.sh`](../scripts/deploy.sh).

## One-time bootstrap

### nginx host

```bash
sudo cp infra/nginx/telescope.conf /etc/nginx/sites-available/telescope.conf
sudo ln  -sf /etc/nginx/sites-available/telescope.conf /etc/nginx/sites-enabled/telescope.conf
# Obtain a Let's Encrypt cert for the public hostname:
sudo certbot --nginx -d telescope.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Edit `telescope.conf`: replace `telescope.example.com` with the real
hostname and `caddy.lan:8080` with the LAN address Caddy listens on.

### caddy host

```bash
sudo mkdir -p /srv/telescope /var/log/caddy
sudo chown -R caddy:caddy /srv/telescope /var/log/caddy
# Initial config — deploy.sh will overwrite this on flip:
sudo cp infra/caddy/Caddyfile.pre-launch /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Edit the `bind` directive in each Caddyfile to the caddy host's LAN IP.

### Pi (backend)

```bash
# Install the package as the telescope user:
sudo useradd --system --create-home --shell /usr/sbin/nologin telescope
sudo install -d -o telescope -g telescope /opt/radiotelescope /var/log/radiotelescope /var/lib/radiotelescope /etc/radiotelescope
sudo -u telescope python -m venv /opt/radiotelescope/venv
sudo -u telescope /opt/radiotelescope/venv/bin/pip install --upgrade pip
sudo -u telescope /opt/radiotelescope/venv/bin/pip install /path/to/checkout

# Production config (uses ${ENV_VAR} substitution to pull secrets):
sudo cp /path/to/checkout/config.example.toml /etc/radiotelescope/config.toml
sudo chown root:telescope /etc/radiotelescope/config.toml
sudo chmod 0640 /etc/radiotelescope/config.toml

# Generate fresh secrets:
sudo cp infra/secrets.example.env /etc/radiotelescope/secrets.env
sudo chown root:telescope /etc/radiotelescope/secrets.env
sudo chmod 0640 /etc/radiotelescope/secrets.env
# Replace each placeholder with a fresh token:
python -c "import secrets; print(secrets.token_urlsafe(48))"
# (paste into /etc/radiotelescope/secrets.env)

# Install the systemd unit but leave it stopped — deploy.sh starts it when
# flipping to live mode.
sudo cp infra/systemd/radiotelescope.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable radiotelescope.service
```

The backend's `public_exposure_errors()` startup gate refuses to come up
with placeholder secrets, so a misconfigured live deploy fails loudly
rather than serving with `change-me` cookies.

## Flipping the deploy mode

The mode lives in [`deploy.env`](deploy.env):

```env
DEPLOY_MODE=pre-launch   # or "live"
CADDY_HOST=caddy.lan
PI_HOST=pi.lan
CADDY_WEBROOT=/srv/telescope
```

To go live:

```bash
# Edit infra/deploy.env: DEPLOY_MODE=live
git commit -am "flip deploy to live"
./scripts/deploy.sh
```

The script:

1. Builds the right frontend (`npm run build:static` for pre-launch,
   `npm run build` for live).
2. `rsync`s the chosen `dist*/` to the caddy host's `/srv/telescope/`.
3. `scp`s the chosen Caddyfile and reloads Caddy.
4. Starts or stops `radiotelescope.service` on the Pi accordingly.

To revert: change `DEPLOY_MODE` back to `pre-launch`, run the script
again. Round-trip is clean.
