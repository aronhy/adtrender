"""Use operator-supplied external SSH configuration; never store credentials here."""
import os
import pathlib
import re

HOST = os.environ.get('ADTRENDER_SSH_HOST', 'netcup-server')

def release_id(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', value):
        raise RuntimeError('Invalid release ID')
    return value

def _file(variable):
    value = os.environ.get(variable)
    if not value or not pathlib.Path(value).is_absolute() or not pathlib.Path(value).is_file():
        raise RuntimeError(variable + ' must reference an existing absolute external file')
    return value

def connection():
    config = _file('ADTRENDER_SSH_CONFIG')
    known_hosts = _file('ADTRENDER_SSH_KNOWN_HOSTS')
    env = dict(os.environ)
    if env.get('ADTRENDER_SSH_ASKPASS'):
        askpass = _file('ADTRENDER_SSH_ASKPASS')
        env.update(SSH_ASKPASS=askpass, SSH_ASKPASS_REQUIRE='force', DISPLAY=env.get('DISPLAY') or 'none')
    common = ['-F', config, '-o', 'UserKnownHostsFile=' + known_hosts,
              '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15']
    return env, common
