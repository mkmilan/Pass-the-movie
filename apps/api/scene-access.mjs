import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createInitialMovie, isMovieAccessible } from '../../packages/shared/movie-state.mjs';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';
import { reserveBudget } from '../../packages/server/budget.mjs';
import { cookiePolicy, validBetaStartKey } from '../../packages/server/beta-security.mjs';
import { activeSlot, grantMatches, turnAccessible, mayManageTurn, slotPath, resetSlotPatch, turnDeadline, inviteDeadline } from '../../packages/server/turns.mjs';

export class SceneError extends Error {
  constructor(code,status){super(code);this.code=code;this.status=status;}
}
export const fail=(code,status)=>{throw new SceneError(code,status);};
const digest=(domain,value)=>createHash('sha256').update(domain+':'+value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const tokenOk=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const csrfFor=token=>digest('csrf',token);
function safeEqual(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&/^[a-f0-9]{64}$/.test(a)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function cookie(req,cookieName){
  const values=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
  if(values.length!==1)return null;
  const value=values[0].slice(cookieName.length+1);return tokenOk(value)?value:null;
}
export function consentSnapshot(value,now) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!=='dev-1'||!['adult','permissions','combineAndDownload','externalSharing'].every(k=>value[k]===true)) fail('CONSENT_REQUIRED',422);
  return {version:'dev-1',adult:true,permissions:true,combineAndDownload:true,externalSharing:true,acceptedAt:now};
}
export function movieDto(movie,token,grant) {
  const n=grant.slotNumber,slot=movie.slots[n-1],current=activeSlot(movie);
  const own={status:slot.status,errorCode:slot.errorCode||null,summary:slot.status==='accepted'?slot.mediaSummary:null};
  const manage=mayManageTurn(movie,grant);
  return {publicId:movie.publicId,status:movie.status,activeSlot:movie.activeSlot,expiresAt:movie.expiresAt.toISOString(),
    slots:movie.slots.map(s=>({number:s.number,status:s.status})),
    mySlot:n,role:grant.role,myScene:own,...(n===1?{scene1:own}:{}),
    turnExpiresAt:slot.status==='accepted'?null:slot.reservationUntil?.toISOString()||null,
    canInvite:manage&&current.status==='open',canReplace:manage&&current.status!=='accepted',
    canReference:n>1&&movie.activeSlot===n&&slot.status!=='accepted',
    canAbandon:movie.status==='collecting'&&movie.activeSlot===n&&slot.status!=='accepted',
    canDelete:grant.role==='creator'||slot.status==='accepted',
    canViewFinal:movie.status==='ready'&&slot.status==='accepted'&&!!movie.final?.key,
    final:movie.status==='ready'&&slot.status==='accepted'&&movie.final?{duration:movie.final.duration,frames:movie.final.frames,bytes:movie.final.bytes,publishedAt:movie.final.publishedAt.toISOString()}:null,
    csrfToken:csrfFor(token)};
}
export function createSceneAccess({collections:c,client,config={},now=()=>new Date()}) {
  const policy=cookiePolicy(config);
  async function sessionFor(req) {
    const token=cookie(req,policy.name);if(!token)return null;
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
    res.cookie(policy.name,token,{...policy.options,maxAge:R.collectLifetimeMs+R.readyLifetimeMs});
  }
  async function create(req,res) {
    if(config.mode==='beta'&&!validBetaStartKey(req.body?.betaStartKey,config.startKeyHash))fail('BETA_INVITE_REQUIRED',403);
    if(req.body?.adult!==true)fail('CONSENT_REQUIRED',422);
    const browser=await prepareSession(req),personal=secret(),grantId=randomUUID(),publicId=randomUUID(),t=now();
    const movie=createInitialMovie({publicId,creatorGrantId:grantId,now:t});
    movie.cleanupPending=[];
    const session=client.startSession();
    try {
      await session.withTransaction(async()=>{
        await reserveBudget(c,session,'movie',t);
        const inserted=await c.movies.insertOne(movie,{session});
        await c.grants.insertOne({movieId:inserted.insertedId,grantId,role:'creator',slotNumber:1,generation:0,capabilityHash:digest('grant',personal),status:'active',createdAt:t,expiresAt:movie.expiresAt},{session});
        await addSessionGrant(browser,grantId,session);
      });
    } finally {await session.endSession();}
    setCookie(res,browser.token);
    return {...movieDto(movie,browser.token,{slotNumber:1,role:'creator',grantId,generation:0,status:'active'}),personalToken:personal};
  }
  async function authorize(req,{mutation=false,slotNumber}={}) {
    const browser=await sessionFor(req);if(!browser)fail('ACCESS_REQUIRED',401);
    if(mutation)requireCsrf(req,browser.token);
    const raw=req.query.slot;
    if(raw!==undefined&&!(typeof raw==='string'&&/^[1-5]$/.test(raw)))fail('NOT_FOUND',404);
    const selected=slotNumber??(raw===undefined?undefined:Number(raw));
    if(slotNumber!==undefined&&raw!==undefined&&Number(raw)!==slotNumber)fail('NOT_FOUND',404);
    const movie=await c.movies.findOne({publicId:req.params.id});
    if(!movie)fail('NOT_FOUND',404);
    const grants=await c.grants.find({movieId:movie._id,grantId:{$in:browser.doc.grantIds},status:'active',...(selected?{slotNumber:selected}:{})}).toArray();
    const matching=grants.filter(g=>grantMatches(movie,g));
    if(!matching.length)fail('NOT_FOUND',404);
    if(!isMovieAccessible(movie,now()))fail('MOVIE_EXPIRED',410);
    if(matching.length!==1)fail('SLOT_REQUIRED',409);
    const grant=matching[0];
    if(!turnAccessible(movie,grant,now()))fail('TURN_EXPIRED',410);
    return {movie,grant,token:browser.token};
  }
  async function recover(req,res) {
    const token=req.body?.personalToken;
    if(!tokenOk(token))fail('NOT_FOUND',404);
    const browser=await prepareSession(req),session=client.startSession();
    let result;
    try {
      await session.withTransaction(async()=>{
        const movie=await c.movies.findOne({publicId:req.params.id},{session});
        if(!movie||!isMovieAccessible(movie,now()))fail('NOT_FOUND',404);
        const grant=await c.grants.findOne({movieId:movie._id,status:'active',capabilityHash:digest('grant',token)},{session});
        if(!grant||!turnAccessible(movie,grant,now()))fail('NOT_FOUND',404);
        await addSessionGrant(browser,grant.grantId,session);
        result=movieDto(movie,browser.token,grant);
      });
    }finally{await session.endSession();}
    setCookie(res,browser.token);
    return result;
  }
  async function issueInvite({movie,grant}) {
    const t=now(),slot=activeSlot(movie);
    if(!isMovieAccessible(movie,t)||!mayManageTurn(movie,grant)||slot.status!=='open')fail('TURN_UNAVAILABLE',409);
    const token=secret(),until=inviteDeadline(movie,t),p=slotPath(slot.number);
    const r=await c.movies.updateOne({_id:movie._id,revision:movie.revision,status:'collecting',activeSlot:slot.number,expiresAt:{$gt:t},[p+'status']:'open',[p+'generation']:slot.generation},
      {$set:{[p+'inviteHash']:digest('invite',token),[p+'inviteExpiresAt']:until,[p+'inviteIssuerGrantId']:grant.grantId},$inc:{revision:1}});
    if(r.modifiedCount!==1)fail('TURN_CONFLICT',409);
    return {inviteToken:token,slot:slot.number,expiresAt:until.toISOString()};
  }
  async function claim(req,res) {
    const invite=req.body?.inviteToken;
    if(req.body?.adult!==true)fail('CONSENT_REQUIRED',422);
    if(!tokenOk(invite))fail('INVITE_INVALID',404);
    const browser=await prepareSession(req),hash=digest('invite',invite),personal=secret(),grantId=randomUUID();
    const session=client.startSession();let result;
    try{
      await session.withTransaction(async()=>{
        const t=now(),movie=await c.movies.findOne({publicId:req.params.id},{session});
        if(!movie||!isMovieAccessible(movie,t))fail('INVITE_INVALID',404);
        const consumed=movie.slots.find(s=>s.claimedInviteHash===hash);
        if(consumed&&browser.doc?.grantIds.includes(consumed.grantId)){
          const existing=await c.grants.findOne({movieId:movie._id,grantId:consumed.grantId,status:'active'},{session});
          if(existing&&turnAccessible(movie,existing,t)){result=movieDto(movie,browser.token,existing);return;}
        }
        const slot=activeSlot(movie);
        if(movie.status!=='collecting'||!slot||slot.number<2||slot.status!=='open'||slot.inviteHash!==hash||!(slot.inviteExpiresAt>t))fail('INVITE_INVALID',404);
        const p=slotPath(slot.number),until=turnDeadline(movie,t);
        const update={$set:{[p+'status']:'claimed',[p+'grantId']:grantId,[p+'reservationUntil']:until,[p+'claimedInviteHash']:hash,[p+'inviteHash']:null,[p+'inviteExpiresAt']:null},$inc:{revision:1}};
        const r=await c.movies.findOneAndUpdate({_id:movie._id,revision:movie.revision,status:'collecting',activeSlot:slot.number,expiresAt:{$gt:t},[p+'status']:'open',[p+'inviteHash']:hash,[p+'inviteExpiresAt']:{$gt:t}},update,{session,returnDocument:'after'});
        if(!r)fail('INVITE_INVALID',404);
        const grant={movieId:movie._id,grantId,role:'contributor',slotNumber:slot.number,generation:slot.generation,capabilityHash:digest('grant',personal),status:'active',createdAt:t,expiresAt:movie.expiresAt};
        await c.grants.insertOne(grant,{session});
        await addSessionGrant(browser,grantId,session);
        result={...movieDto(r,browser.token,grant),personalToken:personal};
      });
    }finally{await session.endSession();}
    setCookie(res,browser.token);return result;
  }
  async function replace(req,{movie,grant,token},{abandon=false}={}) {
    const slot=activeSlot(movie),t=now();
    if(req.body?.confirm!==true)fail('CONFIRMATION_REQUIRED',422);
    if(!isMovieAccessible(movie,t)||movie.status!=='collecting'||!slot)fail('TURN_UNAVAILABLE',409);
    if(abandon){
      if(slot.number!==grant.slotNumber||slot.grantId!==grant.grantId||slot.status==='accepted')fail('TURN_UNAVAILABLE',409);
    }else if(!mayManageTurn(movie,grant))fail('TURN_UNAVAILABLE',409);
    const session=client.startSession();let result;
    try{
      await session.withTransaction(async()=>{
        let patch;
        if(abandon&&slot.number===1){
          const keys=[slot.rawKey,slot.normalizedKey,slot.lastFrameKey].filter(Boolean);
          patch={$set:{status:'deleting',work:null,cleanup:{status:'pending',nextRunAt:t,attempt:0}},$inc:{revision:1}};
          if(keys.length)patch.$addToSet={cleanupPending:{$each:keys}};
        }else patch=resetSlotPatch(movie);
        const updated=await c.movies.findOneAndUpdate({_id:movie._id,revision:movie.revision,status:'collecting',activeSlot:slot.number,expiresAt:{$gt:now()}},patch,{session,returnDocument:'after'});
        if(!updated)fail('TURN_CONFLICT',409);
        if(slot.grantId)await c.grants.updateOne({movieId:movie._id,grantId:slot.grantId,generation:slot.generation},{$set:{status:'revoked'}},{session});
        result=abandon?{status:slot.number===1?'deleting':'abandoned'}:movieDto(updated,token,grant);
      });
    }finally{await session.endSession();}
    return result;
  }
  async function deleteMovie(req,{movie,grant}) {
    const t=now();
    if(req.body?.confirm!==true)fail('CONFIRMATION_REQUIRED',422);
    if(grant.role!=='creator'&&movie.slots[grant.slotNumber-1].status!=='accepted')fail('DELETE_FORBIDDEN',403);
    if(!isMovieAccessible(movie,t))fail('MOVIE_EXPIRED',410);
    const session=client.startSession();
    try{
      await session.withTransaction(async()=>{
        const r=await c.movies.updateOne({_id:movie._id,revision:movie.revision,status:movie.status,expiresAt:{$gt:now()}},
          {$set:{status:'deleting',activeSlot:null,work:null,cleanup:{status:'pending',nextRunAt:now(),attempt:0}},$inc:{revision:1}},{session});
        if(r.modifiedCount!==1)fail('TURN_CONFLICT',409);
        await c.grants.updateMany({movieId:movie._id},{$set:{status:'revoked'}},{session});
      });
    }finally{await session.endSession();}
    return {status:'deleting'};
  }
  async function rotateAccess({movie,grant}) {
    const personal=secret(),t=now();
    if(!isMovieAccessible(movie,t)||!turnAccessible(movie,grant,t))fail('TURN_UNAVAILABLE',409);
    const r=await c.grants.updateOne({movieId:movie._id,grantId:grant.grantId,generation:grant.generation,status:'active'},{$set:{capabilityHash:digest('grant',personal)}});
    if(r.matchedCount!==1)fail('TURN_UNAVAILABLE',409);
    return {personalToken:personal};
  }
  // Allows an existing browser to obtain a CSRF token before creating/recovering
  // another movie. Requires the exact configured origin in the router.
  async function sessionInfo(req){const browser=await sessionFor(req);return {csrfToken:browser?csrfFor(browser.token):null};}
  return {create,authorize,recover,sessionInfo,issueInvite,claim,replace,rotateAccess,deleteMovie};
}
