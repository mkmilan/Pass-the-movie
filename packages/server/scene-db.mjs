export function sceneCollections(db) {
  return {movies:db.collection('movies'),grants:db.collection('grants'),sessions:db.collection('sessions')};
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
    c.sessions.createIndex({expiresAt:1},{expireAfterSeconds:0})
  ]);
}
