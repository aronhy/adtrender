import {posix} from 'node:path';

export function runtimeLock(app, source) {
  const dependencies={playwright:app.dependencies.playwright,'@prisma/client':app.dependencies['@prisma/client'],prisma:app.devDependencies.prisma};
  if(source.lockfileVersion!==3)throw Error('FLEET_LOCK_VERSION_INVALID');
  const pkg={name:'adtrender-collector-runtime',private:true,version:'1.0.0',dependencies};
  const packages={'':{name:pkg.name,version:pkg.version,dependencies}};
  const locate=(name,from='')=>{
    let parent=from;
    for(;;){
      const key=(parent?parent+'/':'')+'node_modules/'+name;
      if(source.packages[key])return key;
      if(!parent)return undefined;
      parent=posix.dirname(parent);if(parent==='.')parent='';
      if(posix.basename(parent)==='node_modules'){parent=posix.dirname(parent);if(parent==='.')parent='';}
    }
  };
  const include=(key)=>{
    if(packages[key])return;
    const original=source.packages[key];
    if(!original||original.link||!original.integrity||!original.resolved?.startsWith('https://registry.npmjs.org/'))throw Error('FLEET_REGISTRY_LOCK_REQUIRED');
    const item={...original};delete item.dev;delete item.devOptional;
    packages[key]=item;
    for(const name of Object.keys({...item.dependencies,...item.optionalDependencies})){
      const child=locate(name,key);if(!child)throw Error('FLEET_LOCK_DEPENDENCY_MISSING');include(child);
    }
    for(const name of Object.keys(item.peerDependencies??{})){
      const peer=locate(name,key);
      if(peer)include(peer);else if(!item.peerDependenciesMeta?.[name]?.optional)throw Error('FLEET_LOCK_PEER_MISSING');
    }
  };
  for(const [name,version] of Object.entries(dependencies)){
    const key=locate(name);
    if(!key||source.packages[key].version!==version)throw Error('FLEET_APP_LOCK_DRIFT');
    include(key);
  }
  return {pkg,lock:{name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:Object.fromEntries(Object.entries(packages).sort(([a],[b])=>a.localeCompare(b)))}};
}
