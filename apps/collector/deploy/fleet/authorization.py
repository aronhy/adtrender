"""Short-lived central permission to run an explicitly assigned platform queue."""
import json
import math
from datetime import datetime, timezone
from pathlib import Path

MAX_TTL = 2400


def epoch(value):
    if not isinstance(value, str): raise ValueError('FLEET_AUTHORIZATION_INVALID')
    date = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if date.tzinfo is None: raise ValueError('FLEET_AUTHORIZATION_INVALID')
    return date.timestamp()


def seconds_left(root, target, platform, now=None):
    now = datetime.now(timezone.utc).timestamp() if now is None else now
    try:
        permit = json.loads((Path(root)/'config'/'authorization.json').read_text())
        manifest = json.loads((Path(root)/'current'/'manifest.json').read_text())
        issued = epoch(permit['issuedAt']); until = epoch(permit['validUntil'])
        if (permit['schema'] != 1 or permit['node'] != target['id'] or permit['revision'] != manifest['revision']
                or permit['scope'] != 'platform_queue' or not isinstance(permit['platforms'], list) or platform not in permit['platforms']
                or not target.get('enabled', True) or not 0 < until-issued <= MAX_TTL
                or issued > now+30): return 0
        if target.get('expiresAt'): until = min(until, epoch(target['expiresAt']))
        # Allow graceful shutdown to complete before central permission expires.
        return max(0, math.floor(until-now-target['shutdownSeconds']-15))
    except (OSError, ValueError, TypeError, KeyError): return 0
