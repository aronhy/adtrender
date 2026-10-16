#!/usr/bin/env python3
"""Export public advertiser-name clues with existing owner access, without grants.
The Snapchat runtime keeps its ingest-only database role. No credentials, user
tables, raw responses or media URLs enter the catalog.
"""
import argparse,datetime,json,os,pathlib,re,subprocess,tempfile

QUERY='''SELECT coalesce(json_agg(x),'[]'::json) FROM (
 SELECT DISTINCT publisher,source FROM (
  SELECT a.name AS publisher,d.key AS source FROM public."Advertiser" a
  JOIN public."DataSource" d ON d.id=a."dataSourceId"
  WHERE d.key IN ('meta_ad_library','google_ads_transparency','tiktok_commercial_library','pinterest_ads_repository','snapchat_ads_gallery')
  UNION ALL
  SELECT n.publisher,d.key AS source FROM public."AdObservation" o
  JOIN public."DataSource" d ON d.id=o."dataSourceId"
  CROSS JOIN LATERAL (VALUES (o.snapshot->>'advertiserName'),(o.snapshot->>'brand'),(o.snapshot#>>'{advertiser,name}')) n(publisher)
  WHERE d.key IN ('meta_ad_library','google_ads_transparency','tiktok_commercial_library','pinterest_ads_repository','snapchat_ads_gallery')
 ) names WHERE length(btrim(publisher)) BETWEEN 1 AND 200
 ORDER BY publisher,source
) x;'''

def build_feed(rows):
 names={}
 for row in rows:
  name=row['publisher'].strip();source=row['source']
  if not re.fullmatch(r'[a-z0-9_-]{1,80}',source):raise ValueError('CANDIDATE_SOURCE_INVALID')
  if not name or len(name)>200 or any(ord(c)<32 or ord(c)==127 for c in name):continue
  entry=names.setdefault(name.lower(),{'publisher':name,'sources':set()});entry['sources'].add(source)
 return {'schema':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'public-name-clues-not-confirmed-snapchat-advertisers',
         'candidates':[{'publisher':v['publisher'],'sources':sorted(v['sources'])} for _,v in sorted(names.items())]}

def load_seed_rows(path):
 data=json.loads(pathlib.Path(path).read_text())
 if data.get('schema')!=1 or data.get('version')!='research-seeds-3' or not isinstance(data.get('candidates'),list):raise ValueError('SEED_CATALOG_INVALID')
 rows=[]
 for c in data['candidates']:
  if not isinstance(c,dict) or not isinstance(c.get('publisher'),str) or c.get('sources')!=['research_seed_catalog'] or not isinstance(c.get('sourceUrl'),str) or not c['sourceUrl'].startswith('https://'):raise ValueError('SEED_CATALOG_INVALID')
  rows.append({'publisher':c['publisher'],'source':'research_seed_catalog'})
 return rows

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',default='/var/lib/snapchat-collector/evidence/advertiser-candidates.json');parser.add_argument('--seed-file',default=str(pathlib.Path(__file__).with_name('research-publishers.json')));args=parser.parse_args()
 seeds=load_seed_rows(args.seed_file)
 result=subprocess.run(['docker','exec','-i','ds-meta-saas-test-database-1','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d','ad_research_test'],
                       input="SET statement_timeout='30s';\n"+QUERY,text=True,capture_output=True,check=True,timeout=45)
 feed=build_feed([*json.loads(result.stdout),*seeds]);feed['seedCatalogVersion']='research-seeds-3';feed['productNameClues']=len(seeds);raw=json.dumps(feed,ensure_ascii=False).encode()
 if len(raw)>16*1024*1024:raise RuntimeError('CANDIDATE_CATALOG_TOO_LARGE')
 path=pathlib.Path(args.output);path.parent.mkdir(parents=True,exist_ok=True)
 fd,name=tempfile.mkstemp(prefix=path.name+'.',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as file:
   file.write(raw);file.flush();os.fsync(file.fileno());os.fchmod(file.fileno(),0o600)
   if os.geteuid()==0:os.fchown(file.fileno(),1000,1000)
  os.replace(name,path)
  directory=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(directory)
  finally:os.close(directory)
 finally:
  if os.path.exists(name):os.unlink(name)
 print(json.dumps({'state':'READY','candidates':len(feed['candidates']),'generatedAt':feed['generatedAt'],'bytes':len(raw)}))

if __name__=='__main__':main()
