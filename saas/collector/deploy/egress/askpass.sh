#!/bin/sh
set -eu
exec /bin/cat "${CREDENTIALS_DIRECTORY:?}/ssh-password"
