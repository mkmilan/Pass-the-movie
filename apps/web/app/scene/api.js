// No arbitrary API destination. Local development and an explicitly paired
// HTTPS app/api domain are the only accepted configurations.
export function browserApiBase(location=window.location){
  const host=location.hostname,local=['localhost','127.0.0.1'].includes(host);
  if(local){
    const origin=new URL(process.env.NEXT_PUBLIC_API_ORIGIN||('http://'+host+':4000'));
    if(origin.hostname!==host||!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('Invalid local API origin.');
    return origin.origin+'/v1';
  }
  const domain=process.env.NEXT_PUBLIC_PTM_SITE_DOMAIN;
  if(!domain||location.origin!=='https://app.'+domain||process.env.NEXT_PUBLIC_API_ORIGIN!=='https://api.'+domain)throw Error('Private beta hosting is not configured.');
  return process.env.NEXT_PUBLIC_API_ORIGIN+'/v1';
}
export function betaBrowser(location=window.location){
  return !['localhost','127.0.0.1'].includes(location.hostname);
}
export async function fetchPrivateMedia(path,{signal}={}){
  const first=await fetch(path,{credentials:'include',cache:'no-store',signal,referrerPolicy:'no-referrer'});
  if(!first.ok)throw Error('MEDIA_UNAVAILABLE');
  if(!first.headers.get('content-type')?.includes('application/json'))return first;
  const grant=await first.json(),url=new URL(grant.url);
  if(url.protocol!=='https:'||!(/^[a-f0-9]{32}(?:\.eu)?\.r2\.cloudflarestorage\.com$/).test(url.hostname)||url.port||url.username||url.password||url.hash||!url.searchParams.has('X-Amz-Signature')||!Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=Date.now())throw Error('MEDIA_LINK_INVALID');
  return fetch(url.href,{credentials:'omit',cache:'no-store',signal,referrerPolicy:'no-referrer',redirect:'error'});
}
