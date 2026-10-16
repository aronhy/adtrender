#!/bin/sh
set -eu
if /usr/bin/docker inspect tiktok-collector >/dev/null 2>&1; then
 echo 'TIKTOK_CONTAINER_ALREADY_EXISTS' >&2
 exit 1
fi
# A fresh anonymous browser is used each batch. Only the stopped process lock is stale.
rm -f /var/lib/tiktok-collector/evidence/process.lock
exec /usr/bin/docker run --rm --name tiktok-collector --init \
 --user 1000:1000 --read-only --cap-drop ALL \
 --security-opt no-new-privileges:true --security-opt seccomp=/opt/tiktok-collector/seccomp_profile.json \
 --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
 --tmpfs /home/node:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700 \
 --shm-size 1g --memory 2g --cpus 2 --pids-limit 384 \
 --network ds-meta-saas-test_data --network ds-meta-saas-test_outbound \
 --env-file /etc/tiktok-collector.env \
 -v /opt/tiktok-collector/code:/opt/ad-research/app/tiktok-service:ro \
 -v /var/lib/tiktok-collector/evidence:/data:rw \
 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
 "${TIKTOK_IMAGE:?Set immutable image ID}" node /opt/ad-research/app/tiktok-service/tiktok-daemon.mjs "$@"
