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

// Browser cannot set Content-Length; XMLHttpRequest supplies the actual Blob
// length. The presigned URL binds that length and the two explicit headers.
export async function sendDirectClip(movie,blob,key,consent,onProgress){
  const base=browserApiBase()+'/movies/'+encodeURIComponent(movie.publicId)+'/scenes/'+movie.mySlot+'/upload';
  const type=blob.type.split(';')[0].toLowerCase();
  async function api(phase,body){
    const res=await fetch(base+'/'+phase,{method:'POST',credentials:'include',cache:'no-store',referrerPolicy:'no-referrer',
      headers:{'Content-Type':'application/json','X-CSRF-Token':movie.csrfToken,'Idempotency-Key':key},body:JSON.stringify(body)});
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw Error(data.code||'UPLOAD_FAILED');
    return data;
  }
  const grant=await api('start',{bytes:blob.size,type,consent:{...consent,version:'dev-1'}});
  if(grant.status!=='uploading')return grant;
  const url=new URL(grant.url);
  const local=!betaBrowser();
  const validOrigin=local?url.origin===(process.env.NEXT_PUBLIC_PTM_LOCAL_STORAGE_ORIGIN||'http://127.0.0.1:9000'):
    url.protocol==='https:'&&/^[a-f0-9]{32}(?:\\.eu)?\\.r2\\.cloudflarestorage\\.com$/.test(url.hostname)&&!url.port;
  const signed=new Set(url.searchParams.get('X-Amz-SignedHeaders')?.split(';'));
  if(!validOrigin||url.username||url.password||url.hash||!url.searchParams.has('X-Amz-Signature')||
     !['content-length','content-type','if-none-match'].every(h=>signed.has(h))||
     !url.pathname.includes('/movies/'+movie.publicId+'/raw/'+movie.mySlot+'/')||
     !Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=Date.now()||
     grant.headers?.['Content-Type']!==type||grant.headers?.['If-None-Match']!=='*')throw Error('UPLOAD_LINK_INVALID');
  function put(){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('PUT',url.href);xhr.withCredentials=false;xhr.timeout=45000;
      xhr.setRequestHeader('Content-Type',type);xhr.setRequestHeader('If-None-Match','*');
      xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.round(e.loaded/e.total*100));};
      xhr.onload=()=>{if((xhr.status>=200&&xhr.status<300)||xhr.status===412)resolve();else reject(Error('UPLOAD_INTERRUPTED'));};
      xhr.onerror=xhr.ontimeout=xhr.onabort=()=>reject(Error('UPLOAD_INTERRUPTED'));
      xhr.send(blob);
    });
  }
  // A lost PUT response may still mean the object arrived. Verify through the
  // authenticated completion endpoint before retrying the same signed attempt.
  for(let attempt=0;attempt<2;attempt++){
    try{await put();}catch{}
    try{return await api('complete',{});}catch(e){
      if(e.message!=='UPLOAD_NOT_FOUND'||attempt||Date.parse(grant.expiresAt)<=Date.now())throw e;
    }
  }
}
