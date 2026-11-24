import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createInitialMovie, isMovieAccessible } from '../../packages/shared/movie-state.mjs';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';

export class SceneError extends Error {
  constructor(code,status){super(code);this.code=code;this.status=status;}
}
export const fail=(code,status)=>{throw new SceneError(code,status);};
const digest=(domain,value)=>createHash('sha256').update(domain+':'+value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const tokenOk=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const csrfFor=token=>digest('csrf',token);
function safeEqual(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&/^[a-f0-9]{64}$/.test(a)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
const cookieName='ptm-dev';
function cookie(req){
  const values=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
  if(values.length!==1)return null;
  const value=values[0].slice(cookieName.length+1);return tokenOk(value)?value:null;
}
export function consentSnapshot(value,now) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!=='dev-1'||!['adult','permissions','combineAndDownload','externalSharing'].every(k=>value[k]===true)) fail('CONSENT_REQUIRED',422);
  return {version:'dev-1',adult:true,permissions:true,combineAndDownload:true,externalSharing:true,acceptedAt:now};
}
export function movieDto(movie,token) {
  return {publicId:movie.publicId,status:movie.status,activeSlot:movie.activeSlot,expiresAt:movie.expiresAt.toISOString(),
    slots:movie.slots.map(s=>({number:s.number,status:s.status})),
    scene1:{status:movie.slots[0].status,errorCode:movie.slots[0].errorCode||null,summary:movie.slots[0].status==='accepted'?movie.slots[0].mediaSummary:null},
    csrfToken:csrfFor(token)};
}
export function createSceneAccess({collections:c,client,now=()=>new Date()}) {
  async function sessionFor(req) {
    const token=cookie(req);if(!token)return null;
    const doc=await c.sessions.findOne({tokenHash:digest('session',token),expiresAt:{$gt:now()}});
    return doc?{token,doc}:null;
  }
  function requireCsrf(req,token) {
    if(!safeEqual(req.get('X-CSRF-Token'),csrfFor(token)))fail('CSRF_INVALID',403);
  }
  async function prepareSession(req) {
    const existing=await sessionFor(req);
    if(existing) {requireCsrf(req,existing.token);return existing;}
    return {token:secret(),doc:null};
  }
  async function addSessionGrant({token,doc},grantId,session) {
    const t=now(),until=new Date(t.getTime()+R.collectLifetimeMs+R.readyLifetimeMs);
    if(doc) {
      // Keep the development session document bounded, including concurrent starts.
      const r=await c.sessions.updateOne({tokenHash:digest('session',token),expiresAt:{$gt:t},'grantIds.99':{$exists:false}},{$addToSet:{grantIds:grantId},$max:{expiresAt:until}},{session});
      if(r.matchedCount!==1)fail('SESSION_LIMIT',409);
    } else await c.sessions.insertOne({tokenHash:digest('session',token),grantIds:[grantId],createdAt:t,expiresAt:until},{session});
  }
  function setCookie(res,token) {
    res.cookie(cookieName,token,{httpOnly:true,sameSite:'lax',secure:false,path:'/',maxAge:R.collectLifetimeMs+R.readyLifetimeMs});
  }
  async function create(req,res) {
    if(req.body?.adult!==true)fail('CONSENT_REQUIRED',422);
    const browser=await prepareSession(req),personal=secret(),grantId=randomUUID(),publicId=randomUUID(),t=now();
    const movie=createInitialMovie({publicId,creatorGrantId:grantId,now:t});
    movie.cleanupPending=[];
    const session=client.startSession();
    try {
      await session.withTransaction(async()=>{
        // Local development cap; a public deployment needs transactional global quotas.
        if(await c.movies.countDocuments({status:'collecting',expiresAt:{$gt:t}},{session})>=20)fail('QUEUE_FULL',503);
        const inserted=await c.movies.insertOne(movie,{session});
        await c.grants.insertOne({movieId:inserted.insertedId,grantId,role:'creator',slotNumber:1,generation:0,capabilityHash:digest('grant',personal),status:'active',createdAt:t,expiresAt:movie.expiresAt},{session});
        await addSessionGrant(browser,grantId,session);
      });
    } finally {await session.endSession();}
    setCookie(res,browser.token);
    return {...movieDto(movie,browser.token),personalToken:personal};
  }
  async function authorize(req,{mutation=false}={}) {
    const browser=await sessionFor(req);if(!browser)fail('ACCESS_REQUIRED',401);
    if(mutation)requireCsrf(req,browser.token);
    const movie=await c.movies.findOne({publicId:req.params.id});
    if(!movie)fail('NOT_FOUND',404);
    const grant=await c.grants.findOne({movieId:movie._id,grantId:{$in:browser.doc.grantIds},role:'creator',slotNumber:1,generation:movie.slots[0].generation,status:'active'});
    if(!grant||grant.grantId!==movie.creatorGrantId||grant.grantId!==movie.slots[0].grantId)fail('NOT_FOUND',404);
    if(!isMovieAccessible(movie,now()))fail('MOVIE_EXPIRED',410);
    return {movie,grant,token:browser.token};
  }
  async function recover(req,res) {
    const token=req.body?.personalToken;
    if(!tokenOk(token))fail('NOT_FOUND',404);
    const browser=await prepareSession(req);
    const movie=await c.movies.findOne({publicId:req.params.id});
    if(!movie||!isMovieAccessible(movie,now()))fail('NOT_FOUND',404);
    const grant=await c.grants.findOne({movieId:movie._id,grantId:movie.creatorGrantId,role:'creator',slotNumber:1,generation:movie.slots[0].generation,status:'active',capabilityHash:digest('grant',token)});
    if(!grant||grant.grantId!==movie.slots[0].grantId)fail('NOT_FOUND',404);
    const session=client.startSession();
    try{await session.withTransaction(async()=>{await addSessionGrant(browser,grant.grantId,session);});}
    finally{await session.endSession();}
    setCookie(res,browser.token);
    return movieDto(movie,browser.token);
  }
  // Allows an existing browser to obtain a CSRF token before creating/recovering
  // another movie. Requires the exact configured origin in the router.
  async function sessionInfo(req){const browser=await sessionFor(req);return {csrfToken:browser?csrfFor(browser.token):null};}
  return {create,authorize,recover,sessionInfo};
}
