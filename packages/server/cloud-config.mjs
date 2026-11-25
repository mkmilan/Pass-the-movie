import { parseApiConfig } from './config.mjs';
import { getDomain } from 'tldts';

// This parser is for an isolated, invite-only staging environment, never a public launch.
export function cloudConfig(env){
  if(env.PTM_PRIVATE_BETA_ENABLED!=='true')return null;
  const c=parseApiConfig(env);
  if(c.nodeEnv!=='production'||c.host!=='0.0.0.0'||env.SINGLE_SCENE_DEV_ENABLED==='true')throw new Error('BETA_HOST_CONFIG_INVALID');
  const domain=env.PTM_SITE_DOMAIN;
  if(typeof domain!=='string'||!(/^[a-z0-9.-]+$/).test(domain)||getDomain(domain,{allowPrivateDomains:true})!==domain||c.webOrigin!=='https://app.'+domain||c.apiOrigin!=='https://api.'+domain)
    throw new Error('BETA_SAME_SITE_REQUIRED');
  if(!/^mongodb\+srv:\/\/[^\s]+$/.test(c.mongodbUri))throw new Error('BETA_ATLAS_REQUIRED');
  let db;
  try{db=new URL(c.mongodbUri);}catch{throw new Error('BETA_ATLAS_REQUIRED');}
  // Explicit database name, no reuse of another app's default database.
  if(!db.hostname.endsWith('.mongodb.net')||db.pathname!=='/pass_the_movie_beta'||db.searchParams.get('tls')==='false'||db.searchParams.get('ssl')==='false'||['tlsAllowInvalidCertificates','tlsAllowInvalidHostnames','tlsInsecure','directConnection'].some(k=>db.searchParams.has(k)))throw new Error('BETA_ATLAS_REQUIRED');
  if(!/^[0-9a-f]{32}$/.test(env.R2_ACCOUNT_ID||'')||!env.R2_ACCESS_KEY_ID||!env.R2_SECRET_ACCESS_KEY||!/^ptm-beta-[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/.test(env.R2_BUCKET||''))throw new Error('BETA_R2_REQUIRED');
  if(!['default','eu'].includes(env.R2_JURISDICTION||''))throw new Error('BETA_R2_JURISDICTION_REQUIRED');
  if(!/^[0-9a-f]{64}$/.test(env.PTM_BETA_START_KEY_HASH||''))throw new Error('BETA_START_KEY_REQUIRED');
  if(!['true','false'].includes(env.NEW_MOVIES_PAUSED||''))throw new Error('NEW_MOVIES_PAUSED_INVALID');
  if(env.PTM_MEDIA_ENABLED!=='false')throw new Error('BETA_MEDIA_REVIEW_REQUIRED');
  // The staging upload gate is intentionally hard-closed in this branch.
  // Do not loosen it until the real hosting isolation and legal gates pass.
  return {...c,mode:'beta',secureCookies:true,siteDomain:domain,newMoviesPaused:env.NEW_MOVIES_PAUSED==='true',startKeyHash:env.PTM_BETA_START_KEY_HASH,mediaEnabled:false,
    endpoint:'https://'+env.R2_ACCOUNT_ID+(env.R2_JURISDICTION==='eu'?'.eu':'')+'.r2.cloudflarestorage.com',
    bucket:env.R2_BUCKET,accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY};
}
