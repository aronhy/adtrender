import importlib.util,pathlib,unittest

spec=importlib.util.spec_from_file_location('export_candidates',pathlib.Path(__file__).with_name('export-candidates.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CandidateExportTests(unittest.TestCase):
 def test_shared_product_names_merge_as_clues_without_confirmed_identity(self):
  import tempfile,json
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'seeds.json';path.write_text(json.dumps({'schema':1,'version':'research-seeds-3','candidates':[{'publisher':'ToonShort','sources':['research_seed_catalog'],'sourceUrl':'https://toonshortplay.com/'}]}))
   feed=module.build_feed([{'publisher':'Old store','source':'meta_ad_library'},*module.load_seed_rows(path)])
   self.assertEqual([x['publisher'] for x in feed['candidates']],['Old store','ToonShort'])
   self.assertEqual(feed['candidates'][1]['sources'],['research_seed_catalog'])
   path.write_text(json.dumps({'schema':1,'version':'research-seeds-3','candidates':[{'publisher':'Fake','sources':['source'],'sourceUrl':'http://private'}]}))
   with self.assertRaises(ValueError):module.load_seed_rows(path)
 def test_public_names_are_deduplicated_without_becoming_confirmed_snapchat_advertisers(self):
  feed=module.build_feed([{'publisher':' Nike ','source':'meta_ad_library'},{'publisher':'NIKE','source':'google_ads_transparency'},{'publisher':'美妆 商店','source':'pinterest_ads_repository'},{'publisher':'bad\nname','source':'meta_ad_library'},{'publisher':'','source':'meta_ad_library'}])
  self.assertEqual(len(feed['candidates']),2)
  self.assertEqual(feed['candidates'][0],{'publisher':'Nike','sources':['google_ads_transparency','meta_ad_library']})
  self.assertEqual(feed['candidates'][1]['publisher'],'美妆 商店')
  self.assertEqual(feed['schema'],1)
 def test_invalid_source_catalog_is_rejected(self):
  with self.assertRaises(ValueError):module.build_feed([{'publisher':'Shop','source':'https://private.example/token'}])

if __name__=='__main__':unittest.main()
