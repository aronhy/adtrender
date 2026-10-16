#!/bin/sh
set -eu
exec /usr/bin/docker run --rm --name pinterest-collector --init \
 --user 1000:1000 --read-only --cap-drop ALL \
 --security-opt no-new-privileges:true --security-opt seccomp=/opt/pinterest-collector/seccomp_profile.json \
 --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
 --tmpfs /home/node:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700 \
 --shm-size 1g --memory 2g --cpus 2 --pids-limit 256 \
 --network ds-meta-saas-test_data --network ds-meta-saas-test_outbound \
 --env-file /etc/pinterest-collector.env \
 -v /opt/pinterest-collector/code:/opt/ad-research/app/pinterest:ro \
 -v /var/lib/pinterest-collector/evidence:/data:rw \
 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
 "${PINTEREST_IMAGE:?Set immutable image ID}" node /opt/ad-research/app/pinterest/daemon.mjs
