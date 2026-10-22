import {prisma} from 'wasp/server';
import {advertiserName,mediaView} from '../server/views';

export async function getCustomerSnapshot(_args:Record<string,never>={}) {
 return {snapshotId:null,asOf:null,enabled:false};
}

export async function getStudioPublicOverview(_args:{snapshotId?:string}={}) {
 const visible={quarantinedAt:null};
 const [ads,advertisers,media,records]=await Promise.all([
  prisma.ad.count({where:visible}),
  prisma.advertiser.count({where:{ads:{some:visible}}}),
  prisma.mediaObject.count({where:{status:'READY',ad:visible}}),
  prisma.ad.findMany({where:{...visible,media:{some:{status:'READY',type:'IMAGE'}}},orderBy:{lastObservedAt:'desc'},take:600,include:{advertiser:true,media:{where:{status:'READY',type:'IMAGE'},take:1,orderBy:{displayOrder:'asc'}}}}),
 ]);
 const featured=records.filter(a=>!/[\u0600-\u06ff\u0750-\u077f]/.test((advertiserName(a)||'')+(a.body||'')+(a.headline||''))).slice(0,8);
 return {counts:{ads,advertisers,media},ads:await Promise.all(featured.map(async a=>({id:a.id,copy:a.headline||a.body||'',advertiserName:advertiserName(a),domain:(()=>{try{return new URL(a.landingPageUrl||'').hostname}catch{return a.advertiser?.pageDomain||''}})(),mediaUrl:a.media[0]?(await mediaView(a.media[0])).displayUrl||null:null,platform:a.publisherPlatforms[0]||a.mediaType})))};
}
