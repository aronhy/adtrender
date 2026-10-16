/** Discovery vocabulary only: these labels never classify a returned ad or its placement. */
export type SeedFamily='ECOMMERCE'|'INFEED';
export interface SeedCategory {id:string;family:SeedFamily;keywords:string[]}
export const SPY_SEED_VERSION='facebook-spy-seeds-2';
const commerce:Record<string,string[]>={
 promotions:['shop now','sales','sale','free shipping','limited offer','new arrivals','buy online','cash on delivery','buy one get one'],
 apparel:['clothing','fashion','dress'],footwear:['shoes','sneakers'],bags:['handbag','backpack'],jewelry:['jewelry','watch'],
 beauty:['skin care','makeup','cosmetics'],fragrance:['perfume'],hair:['hair care'],health:['supplements','vitamins'],
 fitness:['fitness equipment','sportswear'],home:['home decor','kitchenware'],furniture:['furniture','mattress'],garden:['garden','outdoor'],
 electronics:['electronics','headphones'],phones:['phone accessories'],computers:['laptop','computer accessories'],
 pets:['pet supplies','dog food'],baby:['baby products','maternity'],toys:['toys','kids'],food:['food delivery','snacks'],drinks:['coffee','tea'],
 automotive:['car accessories','auto parts'],books:['books','stationery'],crafts:['craft supplies','art prints'],office:['office supplies'],
 tools:['tools','hardware'],travelgear:['luggage'],wholesale:['wholesale','manufacturer','factory direct'],
 marketplaces:['online store','marketplace','shopping app'],digitalgoods:['ebook','digital download'],
};
const infeed:Record<string,string[]>={
 'lead-generation':['get a quote','request a quote','contact us'],'lead-forms':['sign up','register now'],apps:['download app','install now'],
 games:['mobile game','play now'],education:['online course','learn more','free webinar'],saas:['free trial','software','free demo'],
 'local-services':['book now','appointment','near me'],'professional-services':['business services','consultation'],
 'real-estate':['real estate','property','apartment'],finance:['insurance','credit card','loan'],investment:['investment','trading'],
 recruitment:['jobs','hiring','apply now'],travel:['hotel','flight','travel booking'],
 'content-subscriptions':['subscribe','newsletter','streaming'],events:['tickets','event registration'],social:['join now','community'],
 charity:['donate','fundraising'],telecom:['internet plan','mobile plan'],utilities:['solar','energy plan'],
};
export const seedCategories:SeedCategory[]=[...Object.entries(commerce).map(([id,keywords])=>({id,family:'ECOMMERCE' as const,keywords})),...Object.entries(infeed).map(([id,keywords])=>({id,family:'INFEED' as const,keywords}))];

const localCommerce=['apparel','beauty','home','electronics','pets','baby','food','wholesale'];
const localInfeed=['apps','games','education','saas','lead-generation','local-services','content-subscriptions','finance'];
const simplifiedChinese:[string[],string[]]=[
 ['服装','护肤品','家居用品','电子产品','宠物用品','婴儿用品','外卖','批发'],
 ['下载应用','手机游戏','在线课程','免费试用','获取报价','立即预约','订阅','保险'],
];
const localized:Record<string,[string[],string[]]>={
 es:[['ropa','cuidado de la piel','decoración del hogar','electrónica','productos para mascotas','productos para bebés','comida a domicilio','venta al por mayor'],['descargar app','juegos móviles','curso online','prueba gratis','solicitar presupuesto','reservar ahora','suscribirse','seguros']],
 pt:[['roupas','cuidados com a pele','decoração','eletrônicos','produtos para pets','produtos para bebê','delivery','atacado'],['baixar aplicativo','jogos mobile','curso online','teste grátis','solicitar orçamento','agendar agora','assinar','seguro']],
 fr:[['vêtements','soin de la peau','décoration maison','électronique','accessoires animaux','produits bébé','livraison repas','vente en gros'],['télécharger application','jeux mobiles','formation en ligne','essai gratuit','demander un devis','réserver maintenant','abonnez-vous','assurance']],
 de:[['kleidung','hautpflege','wohndekoration','elektronik','tierbedarf','babyprodukte','essen bestellen','großhandel'],['app herunterladen','handyspiele','online kurs','kostenlos testen','angebot anfordern','jetzt buchen','abonnieren','versicherung']],
 it:[['abbigliamento','cura della pelle','arredamento','elettronica','prodotti per animali','prodotti per neonati','consegna cibo','ingrosso'],['scarica app','giochi mobile','corso online','prova gratuita','richiedi preventivo','prenota ora','abbonati','assicurazione']],
 nl:[['kleding','huidverzorging','woondecoratie','elektronica','dierenbenodigdheden','babyproducten','eten bestellen','groothandel'],['app downloaden','mobiele games','online cursus','gratis proefperiode','offerte aanvragen','boek nu','abonneren','verzekering']],
 ja:[['ファッション','スキンケア','インテリア','家電','ペット用品','ベビー用品','フードデリバリー','卸売'],['アプリダウンロード','スマホゲーム','オンライン講座','無料体験','見積もり','予約','サブスク','保険']],
 ko:[['의류','스킨케어','인테리어','전자제품','반려동물 용품','아기용품','음식 배달','도매'],['앱 다운로드','모바일 게임','온라인 강의','무료 체험','견적 문의','지금 예약','구독','보험']],
 zh:[['服飾','保養品','家居用品','電子產品','寵物用品','嬰兒用品','外送','批發'],['下載應用','手機遊戲','線上課程','免費試用','索取報價','立即預約','訂閱','保險']],
 ar:[['ملابس','العناية بالبشرة','ديكور المنزل','إلكترونيات','مستلزمات الحيوانات','منتجات الأطفال','توصيل الطعام','جملة'],['تحميل التطبيق','ألعاب الجوال','دورة تدريبية','تجربة مجانية','طلب عرض سعر','احجز الآن','اشتراك','تأمين']],
 id:[['pakaian','perawatan kulit','dekorasi rumah','elektronik','perlengkapan hewan','perlengkapan bayi','pesan makanan','grosir'],['unduh aplikasi','game mobile','kursus online','uji coba gratis','minta penawaran','pesan sekarang','berlangganan','asuransi']],
 th:[['เสื้อผ้า','สกินแคร์','ของแต่งบ้าน','อิเล็กทรอนิกส์','อุปกรณ์สัตว์เลี้ยง','สินค้าเด็ก','ส่งอาหาร','ขายส่ง'],['ดาวน์โหลดแอป','เกมมือถือ','คอร์สออนไลน์','ทดลองใช้ฟรี','ขอใบเสนอราคา','จองเลย','สมัครสมาชิก','ประกันภัย']],
 vi:[['quần áo','chăm sóc da','trang trí nhà','điện tử','đồ cho thú cưng','đồ sơ sinh','giao đồ ăn','bán sỉ'],['tải ứng dụng','game mobile','khóa học online','dùng thử miễn phí','yêu cầu báo giá','đặt lịch','đăng ký','bảo hiểm']],
};
export function localizedSeeds(language:string):SeedCategory[]{
 const pair=localized[language];if(!pair)return [];
 if(pair[0].length!==localCommerce.length||pair[1].length!==localInfeed.length)throw Error('SPY_LOCALIZED_SEEDS_INVALID');
 return [...pair[0].map((keyword,i)=>({id:localCommerce[i],family:'ECOMMERCE' as const,keywords:language==='zh'?[keyword,simplifiedChinese[0][i]]:[keyword]})),...pair[1].map((keyword,i)=>({id:localInfeed[i],family:'INFEED' as const,keywords:language==='zh'?[keyword,simplifiedChinese[1][i]]:[keyword]}))];
}
