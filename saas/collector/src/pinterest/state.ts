export function validatePinterestOptions(input:{keyword:string;limit:number}) {
 const keyword=input.keyword.trim();
 if(!keyword||keyword.length>120||!Number.isInteger(input.limit)||input.limit<1||input.limit>20)throw Error('PINTEREST_QUERY_INVALID');
 return {keyword,limit:input.limit};
}
export function classifyPinterestPage(input:{status:number|null;text:string;adCount:number}) {
 if(input.status===403)return 'ACCESS_BLOCKED';
 if(input.status===429)return 'RATE_LIMITED';
 if(input.status && input.status>=400)return 'HTTP_ERROR';
 if(/verify you are human|captcha|security check|access denied/i.test(input.text))return 'CHALLENGE';
 if(/log in to continue|sign in to continue/i.test(input.text))return 'LOGIN_REQUIRED';
 if(input.adCount>0)return 'READY';
 if(!input.text.trim())return 'EMPTY_PAGE';
 if(/no ads found|no results found|no ads match/i.test(input.text))return 'NO_RESULTS';
 return 'SOURCE_CHANGED';
}
