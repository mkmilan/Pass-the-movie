import {createHash,timingSafeEqual} from 'node:crypto';
export function validBetaStartKey(value,hash){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))return false;
  return timingSafeEqual(createHash('sha256').update(value).digest(),Buffer.from(hash,'hex'));
}
export function cookiePolicy(config={}){
  const secure=config.mode==='beta'&&config.secureCookies===true;
  return {name:secure?'__Host-ptm':'ptm-dev',options:{httpOnly:true,sameSite:'lax',secure,path:'/'}};
}
