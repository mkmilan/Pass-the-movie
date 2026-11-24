// Pure domain helpers only. They do not authorize requests or persist transitions.
// Atomic conditional MongoDB writes and grant checks are required in the API/worker.
import { GAME_RULES, MOVIE_STATUS, SLOT_STATUS } from './rules.mjs';
function validDate(value) {return value instanceof Date && Number.isFinite(value.getTime());}
export function createInitialMovie({publicId,creatorGrantId,now}) {
  if(typeof publicId!=="string"||!publicId||typeof creatorGrantId!=="string"||!creatorGrantId||!validDate(now)) throw new TypeError("Movie ID, creator grant ID and valid server date required");
  const expiresAt=new Date(now.getTime()+GAME_RULES.collectLifetimeMs);
  return {publicId,schemaVersion:1,status:"collecting",createdAt:new Date(now),expiresAt,readyAt:null,revision:0,creatorGrantId,activeSlot:1,
    slots:Array.from({length:GAME_RULES.sceneCount},(_,i)=>({number:i+1,status:i===0?"claimed":"locked",grantId:i===0?creatorGrantId:null,reservationUntil:i===0?new Date(expiresAt):null,generation:0,inviteHash:null,inviteExpiresAt:null,inviteIssuerGrantId:null,uploadAttemptId:null,uploadStartedAt:null,rawKey:null,normalizedKey:null,lastFrameKey:null,consent:null,acceptedAt:null,mediaSummary:null,errorCode:null})),
    work:null,final:null,cleanup:{status:"none",nextRunAt:null,attempt:0},purgeAt:null};
}

export function isMovieAccessible(movie,now) {
  return !!movie && validDate(now) && validDate(movie.expiresAt) && ["collecting","assembling","ready","failed"].includes(movie.status) && now.getTime()<movie.expiresAt.getTime();
}

export function assertMovieShape(movie) {
  if(!movie||!MOVIE_STATUS.includes(movie.status)||!validDate(movie.createdAt)||!validDate(movie.expiresAt)||movie.expiresAt<=movie.createdAt||!Number.isSafeInteger(movie.revision)||movie.revision<0) throw new Error("Invalid movie state");
  if(!Array.isArray(movie.slots)||movie.slots.length!==GAME_RULES.sceneCount||movie.slots.some((s,i)=>!s||s.number!==i+1||!SLOT_STATUS.includes(s.status)||!Number.isSafeInteger(s.generation)||s.generation<0)) throw new Error("Invalid movie slots");
  if(movie.slots[0].grantId!==movie.creatorGrantId||!movie.creatorGrantId) throw new Error("Creator slot mismatch");
  if(movie.status==="collecting"){
    if(!Number.isInteger(movie.activeSlot)||movie.activeSlot<1||movie.activeSlot>GAME_RULES.sceneCount) throw new Error("Invalid active slot");
    for(const slot of movie.slots){
      if(slot.number<movie.activeSlot&&slot.status!=="accepted") throw new Error("Previous slot not accepted");
      if(slot.number===movie.activeSlot&&!["open","claimed","uploading","queued","retryable"].includes(slot.status)) throw new Error("Invalid current slot state");
      if(slot.number>movie.activeSlot&&slot.status!=="locked") throw new Error("Future slot must remain locked");
    }
  }
  if(["assembling","ready","failed"].includes(movie.status)&&(movie.activeSlot!==null||movie.slots.some(s=>s.status!=="accepted"))) throw new Error("Assembly requires five accepted scenes");
  if(movie.status==="ready"&&(!validDate(movie.readyAt)||!movie.final?.key||movie.expiresAt.getTime()!==movie.readyAt.getTime()+GAME_RULES.readyLifetimeMs)) throw new Error("Invalid published movie");
  return true;
}
