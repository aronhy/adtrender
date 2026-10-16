import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from release import SSHRemote, runtime_identity, verified_image


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.info={'Id':'sha256:'+'b'*64,'Architecture':'amd64','Os':'linux','Config':{'User':'node','Env':['NODE_ENV=production']},'RootFS':{'Type':'layers','Layers':['sha256:'+'c'*64]}}
        self.expected=runtime_identity(copy.deepcopy(self.info))
        self.reference='adtrender-collector-runtime:'+'a'*40
    def test_store_specific_id_is_allowed_only_for_identical_content(self):
        self.assertEqual(verified_image(self.info,self.expected),self.info['Id'])
        for field in ['Architecture','Os','Config','RootFS']:
            changed=copy.deepcopy(self.info)
            changed[field]={'Layers':['sha256:'+'d'*64]} if field=='RootFS' else {'User':'root'} if field=='Config' else 'changed'
            with self.assertRaisesRegex(ValueError,'FLEET_IMAGE_CONTENT_MISMATCH'):
                verified_image(changed,self.expected)
    def test_legacy_api_defaults_match_current_api_omissions(self):
        legacy=copy.deepcopy(self.info)
        legacy['Config'].update({'Labels':None,'OnBuild':None,'Volumes':None,'Hostname':'','Domainname':'','Image':'','AttachStdin':False,'AttachStdout':False,'AttachStderr':False,'OpenStdin':False,'StdinOnce':False,'Tty':False})
        self.assertEqual(runtime_identity(legacy),self.expected)
        legacy['Config']['Labels']={'supply-chain':'changed'}
        with self.assertRaisesRegex(ValueError,'FLEET_IMAGE_CONTENT_MISMATCH'):verified_image(legacy,self.expected)
    def test_empty_nested_values_are_preserved_as_meaningful_config(self):
        changed=copy.deepcopy(self.info);changed['Config']['Volumes']={'/data':{}}
        with self.assertRaisesRegex(ValueError,'FLEET_IMAGE_CONTENT_MISMATCH'):verified_image(changed,self.expected)
    def test_tag_is_inspected_after_load_and_local_id_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.write_bytes(b'fixture')
            remote=SSHRemote.__new__(SSHRemote);remote.image_archive=archive
            remote.connections={'target':SimpleNamespace(command=lambda args:args,env={})}
            calls=[]
            def run(args,**kwargs):
                calls.append(args)
                if len(calls)==1:return SimpleNamespace(returncode=1,stdout='')
                return SimpleNamespace(returncode=0,stdout=json.dumps([self.info]))
            with patch('release.subprocess.run',side_effect=run):
                self.assertEqual(remote.image('sha256:'+'a'*64,self.reference,self.expected),self.info['Id'])
            self.assertEqual(calls,[['docker','image','inspect',self.reference],['docker','load'],['docker','image','inspect',self.reference]])
    def test_retry_replaces_mismatched_cache_and_verifies_the_new_image(self):
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.touch()
            remote=SSHRemote.__new__(SSHRemote);remote.image_archive=archive
            remote.connections={'target':SimpleNamespace(command=lambda args:args,env={})}
            stale=copy.deepcopy(self.info);stale['RootFS']['Layers']=['sha256:'+'d'*64]
            responses=[SimpleNamespace(returncode=0,stdout=json.dumps([stale])),SimpleNamespace(returncode=0),SimpleNamespace(returncode=0,stdout=json.dumps([self.info]))]
            with patch('release.subprocess.run',side_effect=responses) as run:
                self.assertEqual(remote.image('sha256:'+'a'*64,self.reference,self.expected),self.info['Id'])
                self.assertEqual(run.call_args_list[1].args[0],['docker','load'])
    def test_successful_load_without_visible_image_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.touch()
            remote=SSHRemote.__new__(SSHRemote);remote.image_archive=archive
            remote.connections={'target':SimpleNamespace(command=lambda args:args,env={})}
            responses=[SimpleNamespace(returncode=1,stdout=''),SimpleNamespace(returncode=0),SimpleNamespace(returncode=1,stdout='')]
            with patch('release.subprocess.run',side_effect=responses),self.assertRaisesRegex(RuntimeError,'FLEET_RUNTIME_IMAGE_MISSING'):
                remote.image('sha256:'+'a'*64,self.reference,self.expected)

if __name__=='__main__':unittest.main()
