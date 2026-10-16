#!/usr/bin/env python3
"""Keep the existing source-owned Snapchat candidate producer and mirror its feed."""
import argparse
import json
import os
import subprocess
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from fleet_config import load


def validate_feed(body,now=None):
    if len(body)>16*1024*1024:raise ValueError('FLEET_CANDIDATE_FEED_INVALID')
    value=json.loads(body);now=now or datetime.now(timezone.utc)
    try: generated=datetime.fromisoformat(value['generatedAt'].replace('Z','+00:00'))
    except (ValueError,KeyError,AttributeError,TypeError):raise ValueError('FLEET_CANDIDATE_FEED_INVALID') from None
    # Schema 1 producer omits this optional flag for a complete atomic export.
    if not isinstance(value,dict) or value.get('schema')!=1 or ('truncated' in value and value['truncated'] is not False) or not isinstance(value.get('candidates'),list) or generated.tzinfo is None or generated>now+timedelta(days=1):
        raise ValueError('FLEET_CANDIDATE_FEED_INVALID')
    return value


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);args=parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}',args.node):raise ValueError('FLEET_NODE_INVALID')
    root=Path('/opt/adtrender-collectors')/args.node
    target=next(x for x in load(root/'config'/'fleet.json')['targets'] if x['id']==args.node)
    result=subprocess.run(['docker','exec',target['databaseRelay'],'/usr/bin/ssh','-F','/relay/ssh.conf','primary','cat','/var/lib/snapchat-collector/evidence/advertiser-candidates.json'],capture_output=True,timeout=45)
    if result.returncode or len(result.stdout)>16*1024*1024:raise RuntimeError('FLEET_CANDIDATE_READ_FAILED')
    value=validate_feed(result.stdout)
    path=root/'state'/'snapchat'/'advertiser-candidates.json';temporary=path.with_suffix('.pending')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'wb') as handle:handle.write(result.stdout);handle.flush();os.fsync(handle.fileno())
        os.chown(temporary,1000,1000);os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)
    print(json.dumps({'node':args.node,'status':'CANDIDATES_REFRESHED','count':len(value['candidates'])}))


if __name__=='__main__':
    try:main()
    except Exception:print('FLEET_CANDIDATE_REFRESH_FAILED',file=__import__('sys').stderr);raise SystemExit(1)
