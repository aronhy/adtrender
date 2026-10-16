#!/bin/sh
set -eu
# systemd has removed the previous container before this entry point runs.
# Never touch profile locks if another collector container still exists.
if /usr/bin/docker inspect google-collector >/dev/null 2>&1; then
 echo 'GOOGLE_CONTAINER_ALREADY_EXISTS' >&2
 exit 1
fi
rm -f /var/lib/google-collector/evidence/browser-profile/SingletonLock \
 /var/lib/google-collector/evidence/browser-profile/SingletonCookie \
 /var/lib/google-collector/evidence/browser-profile/SingletonSocket
exec /usr/bin/docker run --rm --name google-collector --init \
 --user 1000:1000 --read-only --cap-drop ALL \
 --security-opt no-new-privileges:true --security-opt seccomp=/opt/google-collector/seccomp_profile.json \
 --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
 --tmpfs /home/node:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700 \
 --shm-size 1g --memory 2g --cpus 2 --pids-limit 384 \
 --network ds-meta-saas-test_data --network ds-meta-saas-test_outbound \
 --env-file /etc/google-collector.env \
 -v /opt/google-collector/code:/opt/ad-research/app/google-service:ro \
 -v /var/lib/google-collector/evidence:/data:rw \
 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
 "${GOOGLE_IMAGE:?Set immutable image ID}" node /opt/ad-research/app/google-service/google-daemon.mjs
