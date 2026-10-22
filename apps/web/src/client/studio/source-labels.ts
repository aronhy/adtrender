const sourceLabels:Record<string,string>={
 meta_ad_library:'Meta 广告资料库',google_ads_transparency:'Google 广告透明度中心',
 tiktok_commercial_library:'TikTok 商业内容库',pinterest_ads_repository:'Pinterest 广告资料库',
 snapchat_ads_gallery:'Snapchat 广告库',microsoft_ad_library:'Microsoft 广告库',
 linkedin_ad_library:'LinkedIn 广告库',bigspy:'BigSpy',adflex:'AdFlex',
};
/** A provider identifies where facts were collected, independently of the ad's publisher platforms. */
export function sourceLabel(key:string|null|undefined):string{return key?sourceLabels[key]||key:'来源未披露';}
