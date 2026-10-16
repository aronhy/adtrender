#!/bin/sh
set -eu
control_env=/etc/meta-collector-control.env
control_mode=${META_CONTROL_MODE:-CONFIG_QUEUE}
case "$control_mode" in LEGACY_QUEUE|CONFIG_QUEUE|TASK_CLAIM) ;; *) echo 'META_CONTROL_MODE_INVALID' >&2; exit 1 ;; esac
if [ ! -f "$control_env" ] || [ -L "$control_env" ]; then
 echo 'META_CONTROL_ENV_REQUIRED' >&2
 exit 1
fi
permissions=$(stat -c %a "$control_env" 2>/dev/null || stat -f %Lp "$control_env")
if [ "$permissions" != 600 ]; then echo 'META_CONTROL_ENV_PRIVATE_REQUIRED' >&2; exit 1; fi
for key in COLLECTOR_CONTROL_URL COLLECTOR_NODE_ID COLLECTOR_INCARNATION_ID COLLECTOR_NODE_TOKEN COLLECTOR_CODE_REVISION COLLECTOR_CAPABILITY_DIGEST; do
 if ! awk -F= -v expected="$key" '$1==expected && length(substr($0,index($0,"=")+1))>0{found=1}END{exit !found}' "$control_env"; then
  echo 'META_CONTROL_ENV_INCOMPLETE' >&2
  exit 1
 fi
done
receipt_root=${META_RECEIPT_ROOT:-/var/lib/meta-collector/evidence}
case "$receipt_root" in /*) ;; *) echo 'META_RECEIPT_ROOT_INVALID' >&2; exit 1 ;; esac
case "$receipt_root" in *:*) echo 'META_RECEIPT_ROOT_INVALID' >&2; exit 1 ;; esac
if [ ! -d "$receipt_root" ]; then echo 'META_RECEIPT_ROOT_REQUIRED' >&2; exit 1; fi
# systemd has removed the previous container before this entry point runs.
# Never touch profile locks if another collector container still exists.
if /usr/bin/docker inspect meta-collector >/dev/null 2>&1; then
 echo 'META_CONTAINER_ALREADY_EXISTS' >&2
 exit 1
fi
rm -f /var/lib/meta-collector/evidence/browser-profile/SingletonLock \
 /var/lib/meta-collector/evidence/browser-profile/SingletonCookie \
 /var/lib/meta-collector/evidence/browser-profile/SingletonSocket
exec /usr/bin/docker run --rm --name meta-collector --init \
 --user 1000:1000 --read-only --cap-drop ALL \
 --security-opt no-new-privileges:true --security-opt seccomp=/opt/meta-collector/seccomp_profile.json \
 --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
 --tmpfs /home/node:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700 \
 --shm-size 1g --memory 2g --cpus 2 --pids-limit 384 \
 --network ds-meta-saas-test_data --network ds-meta-saas-test_outbound \
 --env-file /etc/meta-collector.env \
 --env-file "$control_env" \
 --env COLLECTOR_CONTROL_MODE="$control_mode" --env COLLECTOR_RECEIPT_DIR=/dispatch \
 -v /opt/meta-collector/code:/opt/ad-research/app/meta-service:ro \
 -v /var/lib/meta-collector/evidence:/data:rw \
 -v "$receipt_root":/dispatch:rw \
 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
 "${META_IMAGE:?Set immutable image ID}" node /opt/ad-research/app/meta-service/meta-daemon.mjs "$@"
