#!/bin/sh
set -eu
exec /usr/bin/docker run --rm --name ad-media-storage --init \
 --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
 --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
 --memory 3g --cpus 2 --pids-limit 128 \
 --network ds-meta-saas-test_data --network ds-meta-saas-test_outbound \
 --env-file /etc/ad-media-storage.env \
 -v /opt/ad-media-storage/code:/opt/ad-research/app/media-storage:ro \
 -v /var/lib/ad-media-storage:/data:rw \
 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
 "${MEDIA_IMAGE:?Use an immutable image ID}" node /opt/ad-research/app/media-storage/media-storage.mjs
