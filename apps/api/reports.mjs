import { randomUUID } from 'node:crypto';
import { reserveBudget } from '../../packages/server/budget.mjs';
import { fail } from './scene-access.mjs';

export const REPORT_REASONS=Object.freeze(['privacy','abuse','copyright','illegal','other']);
export function validateReport(body){
  if(!body||!REPORT_REASONS.includes(body.reason))fail('REPORT_INVALID',422);
  const id=body.movieId;
  if(id!==undefined&&id!==''&&(typeof id!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))))fail('REPORT_INVALID',422);
  // Do not accept free text, recordings, secret URLs or contact details.
  if(Object.keys(body).some(k=>!['movieId','reason'].includes(k)))fail('REPORT_INVALID',422);
  return {reason:body.reason,moviePublicId:id? id.toLowerCase():null};
}
export function createReporter({collections:c,client,now=()=>new Date()}){
  return async req=>{
    const data=validateReport(req.body),createdAt=now(),reportId=randomUUID();
    const session=client.startSession();
    try{
      await session.withTransaction(async()=>{
        await reserveBudget(c,session,'report',createdAt);
        await c.reports.insertOne({...data,reportId,status:'open',createdAt,purgeAt:new Date(createdAt.getTime()+90*86400000)},{session});
      });
    }finally{await session.endSession();}
    // Identical result whether a supplied movie ID exists or not.
    return {reportId,status:'received'};
  };
}
