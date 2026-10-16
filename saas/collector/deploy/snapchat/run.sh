#!/bin/sh
set -eu
exec /usr/bin/docker run --rm --name snapchat-collector --init \
 --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
 --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
 --memory 512m --cpus 1 --pids-limit 128 \
 --network ds-meta-saas-test_data --network ds-meta-saas-test_outbound \
 --env-file /etc/snapchat-collector.env \
 -v /opt/snapchat-collector/code:/opt/ad-research/app/snapchat-service:ro \
 -v /var/lib/snapchat-collector/evidence:/data:rw \
 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
 "${SNAPCHAT_IMAGE:?Set immutable image ID}" node /opt/ad-research/app/snapchat-service/snapchat-daemon.mjs
