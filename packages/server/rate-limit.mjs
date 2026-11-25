import { createHmac, randomBytes } from 'node:crypto';

export class RateError extends Error{
  constructor(retryAfter){super('RATE_LIMITED');this.status=429;this.code='RATE_LIMITED';this.retryAfter=retryAfter;}
}
// Local, single-process, bounded rate limiter. Raw IP addresses are not stored.
// Distributed production limits and trusted-proxy configuration are separate gates.
export function createRateLimiter({now=()=>new Date(),capacity=4096}={}){
  const salt=randomBytes(32),entries=new Map();
  let sweepAt=0;
  function check(category,identity,max,windowMs){
    const t=now().getTime();
    if(t>=sweepAt||entries.size>=capacity){
      for(const [key,entry] of entries)if(entry.until<=t)entries.delete(key);
      sweepAt=t+60000;
    }
    const key=createHmac('sha256',salt).update(category+':'+identity).digest('hex');
    let entry=entries.get(key);
    if(!entry||entry.until<=t){
      if(!entry&&entries.size>=capacity)throw new RateError(60);
      entry={count:0,until:t+windowMs};entries.set(key,entry);
    }
    if(entry.count>=max)throw new RateError(Math.max(1,Math.ceil((entry.until-t)/1000)));
    entry.count++;
  }
  return {check};
}
