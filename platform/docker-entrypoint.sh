#!/usr/bin/env sh
set -eu

# If beta auth is enabled, write passwords.txt from the RT_BETA_PASSWORDS env
# var. One password per line. Coolify users paste their password list into a
# multi-line env var instead of mounting a file.
if [ -n "${RT_BETA_PASSWORDS:-}" ]; then
    printf '%s\n' "$RT_BETA_PASSWORDS" > /app/passwords.txt
    chmod 0600 /app/passwords.txt
fi

# Ensure the persistent state directory exists. Coolify users mount a volume
# at /app/state; without a mount, this just makes the directory inside the
# container (state is lost on recreation — fine for staging, not for prod).
mkdir -p /app/state

exec "$@"
