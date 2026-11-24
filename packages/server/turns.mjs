// Pure slot helpers shared by the API and worker.
import { GAME_RULES as R } from '../shared/rules.mjs';

export const slotPath = n => {
  if (!Number.isInteger(n) || n < 1 || n > R.sceneCount) throw new Error('INVALID_SLOT');
  return 'slots.' + (n - 1) + '.';
};
export const activeSlot = movie => Number.isInteger(movie.activeSlot) ? movie.slots[movie.activeSlot - 1] : null;
export function grantMatches(movie, grant) {
  const slot = movie.slots[grant?.slotNumber - 1];
  return !!slot && grant.status === 'active' && slot.grantId === grant.grantId && slot.generation === grant.generation &&
    (slot.number === 1 ? grant.role === 'creator' && movie.creatorGrantId === grant.grantId : grant.role === 'contributor');
}
export function turnAccessible(movie, grant, now) {
  if (!grantMatches(movie, grant)) return false;
  const slot = movie.slots[grant.slotNumber - 1];
  return slot.status === 'accepted' || (movie.status === 'collecting' && movie.activeSlot === slot.number &&
    (['uploading','queued'].includes(slot.status) || (['claimed','retryable'].includes(slot.status) && slot.reservationUntil > now)));
}
export function mayManageTurn(movie, grant) {
  const slot = activeSlot(movie);
  return movie.status === 'collecting' && !!slot && slot.number > 1 && grantMatches(movie, grant) &&
    movie.slots[grant.slotNumber - 1].status === 'accepted' &&
    (grant.role === 'creator' || grant.slotNumber === slot.number - 1);
}
export function resetSlotPatch(movie) {
  const slot = activeSlot(movie);
  if (!slot || slot.number < 2 || !['open','claimed','retryable','uploading','queued'].includes(slot.status)) throw new Error('TURN_NOT_REPLACEABLE');
  const fresh = {number:slot.number,status:'open',grantId:null,reservationUntil:null,generation:slot.generation+1,
    inviteHash:null,inviteExpiresAt:null,inviteIssuerGrantId:null,uploadAttemptId:null,uploadStartedAt:null,
    rawKey:null,normalizedKey:null,lastFrameKey:null,consent:null,acceptedAt:null,mediaSummary:null,errorCode:null};
  const keys = [slot.rawKey,slot.normalizedKey,slot.lastFrameKey].filter(Boolean);
  const update = {$set:{['slots.'+(slot.number-1)]:fresh,work:null},$inc:{revision:1}};
  if (keys.length) update.$addToSet = {cleanupPending:{$each:keys}};
  return update;
}
export function turnDeadline(movie, now) {
  return new Date(Math.min(movie.expiresAt.getTime(), now.getTime()+R.turnLifetimeMs));
}
export function inviteDeadline(movie, now) {
  return new Date(Math.min(movie.expiresAt.getTime(), now.getTime()+R.inviteLifetimeMs));
}
