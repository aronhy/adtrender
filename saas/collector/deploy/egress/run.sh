#!/bin/sh
set -eu
exec /usr/bin/docker run --rm --name adtrender-egress-us01 --init \
 --label adtrender.role=private-egress --label adtrender.node=us01 \
 --user 0:0 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
 --tmpfs /tmp:rw,nosuid,nodev,size=16m,mode=1777 \
 --memory 128m --cpus 0.10 --pids-limit 32 \
 --network ds-meta-saas-test_outbound \
 --env SSH_ASKPASS=/etc/adtrender-egress/us01/askpass.sh \
 --env SSH_ASKPASS_REQUIRE=force --env DISPLAY=adtrender-private:0 \
 --env CREDENTIALS_DIRECTORY=/run/credentials \
 -v /etc/adtrender-egress/us01:/etc/adtrender-egress/us01:ro \
 -v "${CREDENTIALS_DIRECTORY:?}:/run/credentials:ro" \
 --log-driver json-file --log-opt max-size=1m --log-opt max-file=2 \
 "${EGRESS_IMAGE:?Set immutable egress image ID}" \
 -F /etc/adtrender-egress/us01/ssh.conf -N -g -D 0.0.0.0:11081 us01
