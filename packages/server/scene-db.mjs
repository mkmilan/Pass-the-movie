import { initializeBudget } from './budget.mjs';
export function sceneCollections(db) {
  return {movies:db.collection('movies'),grants:db.collection('grants'),sessions:db.collection('sessions'),budgets:db.collection('budgets'),reports:db.collection('reports')};
}
export async function ensureSceneIndexes(c) {
  await Promise.all([
    c.movies.createIndex({publicId:1},{unique:true}),
    c.movies.createIndex({status:1,expiresAt:1}),
    c.movies.createIndex({'work.status':1,'work.nextRunAt':1,'work.leaseUntil':1}),
    c.grants.createIndex({grantId:1},{unique:true}),
    c.grants.createIndex({capabilityHash:1},{unique:true}),
    c.grants.createIndex({movieId:1,slotNumber:1,generation:1}),
    c.sessions.createIndex({tokenHash:1},{unique:true}),
    c.sessions.createIndex({expiresAt:1},{expireAfterSeconds:0}),
    c.movies.createIndex({status:1,'cleanup.nextRunAt':1}),
    c.grants.createIndex({movieId:1}),
    c.budgets.createIndex({purgeAt:1},{expireAfterSeconds:0}),
    c.reports.createIndex({purgeAt:1},{expireAfterSeconds:0}),
    c.reports.createIndex({status:1,createdAt:1}),
    c.reports.createIndex({reportId:1},{unique:true})
  ]);
  await initializeBudget(c);
}
