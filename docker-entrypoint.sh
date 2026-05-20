#!/bin/sh
# Runs before the app starts. Creates passwords.txt from the RT_BETA_PASSWORDS
# environment variable if the file doesn't already exist.
#
# In Coolify, set RT_BETA_PASSWORDS to a newline-separated list of passwords,
# e.g. "supersecret\nanothersecret". Each line becomes one valid password.
# If auth is disabled you can leave this variable unset.

if [ -n "$RT_BETA_PASSWORDS" ] && [ ! -f passwords.txt ]; then
    printf '%s\n' "$RT_BETA_PASSWORDS" > passwords.txt
    echo "docker-entrypoint: wrote passwords.txt from RT_BETA_PASSWORDS"
fi

exec "$@"
