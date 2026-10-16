#!/bin/sh
set -eu
exec /usr/bin/docker run --rm --name "${FLEET_RELAY_NAME:?}" --init \
 --label adtrender.fleet.role=database-relay --user 0:0 \
 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
 --memory 128m --cpus 0.10 --pids-limit 32 \
 --network "${FLEET_NETWORK:?}" \
 --env SSH_ASKPASS=/relay/askpass.sh --env SSH_ASKPASS_REQUIRE=force \
 --env DISPLAY=adtrender-private:0 --env CREDENTIALS_DIRECTORY=/run/credentials \
 -v "${FLEET_RELAY_DIR:?}:/relay:ro" -v "${CREDENTIALS_DIRECTORY:?}:/run/credentials:ro" \
 --log-driver json-file --log-opt max-size=1m --log-opt max-file=2 \
 --entrypoint /usr/bin/ssh \
 "${FLEET_RELAY_IMAGE:?}" -F /relay/ssh.conf -N -g -L "0.0.0.0:5432:${FLEET_DATABASE_IP:?}:5432" primary
