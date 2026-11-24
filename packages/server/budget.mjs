import { GAME_RULES as R } from '../shared/rules.mjs';

export const BUDGET=Object.freeze({moviesPerDay:50,activeMovies:100,queuedMovies:100,dailyUploadBytes:500*1024*1024});
export class BudgetError extends Error{
  constructor(code,status=429){super(code);this.code=code;this.status=status;}
}
export async function initializeBudget(c){
  await c.budgets.updateOne({_id:'gate'},{$setOnInsert:{sequence:0}},{upsert:true});
}
// Must run inside the SAME Mongo transaction as movie creation or upload
// reservation. The singleton write serializes concurrent quota checks.
// Charge maximum possible clip bytes upfront; rejected/interrupted attempts
// are deliberately not refunded. Duplicate idempotency requests do not reserve.
export async function reserveBudget(c,session,kind,now){
  if(!session?.inTransaction())throw new Error('BUDGET_TRANSACTION_REQUIRED');
  if(!['movie','upload'].includes(kind))throw new Error('BUDGET_KIND_INVALID');
  const lock=await c.budgets.updateOne({_id:'gate'},{$inc:{sequence:1}},{session});
  if(lock.matchedCount!==1)throw new Error('BUDGET_NOT_INITIALIZED');
  const day=now.toISOString().slice(0,10),id='day:'+day;
  await c.budgets.updateOne({_id:id},{$setOnInsert:{movies:0,bytes:0,purgeAt:new Date(Date.parse(day+'T00:00:00Z')+3*86400000)}},{upsert:true,session});
  if(kind==='movie'){
    const count=await c.movies.countDocuments({status:{$in:['collecting','assembling']},expiresAt:{$gt:now}},{session});
    if(count>=BUDGET.activeMovies)throw new BudgetError('ACTIVE_MOVIE_LIMIT',503);
    const result=await c.budgets.updateOne({_id:id,movies:{$lt:BUDGET.moviesPerDay}},{$inc:{movies:1}},{session});
    if(result.modifiedCount!==1)throw new BudgetError('DAILY_MOVIE_LIMIT');
  }else{
    const queued=await c.movies.countDocuments({expiresAt:{$gt:now},$or:[{status:'assembling'},{status:'collecting','slots.status':{$in:['uploading','queued']}}]},{session});
    if(queued>=BUDGET.queuedMovies)throw new BudgetError('QUEUE_FULL',503);
    const result=await c.budgets.updateOne({_id:id,bytes:{$lte:BUDGET.dailyUploadBytes-R.maxUploadBytes}},{$inc:{bytes:R.maxUploadBytes}},{session});
    if(result.modifiedCount!==1)throw new BudgetError('DAILY_UPLOAD_LIMIT');
  }
}
