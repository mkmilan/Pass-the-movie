import { parseApiConfig } from './config.mjs';

// Phase 2 is explicitly local-only. No public test upload endpoint.
export function singleSceneConfig(env) {
  const config = parseApiConfig(env);
  if (env.SINGLE_SCENE_DEV_ENABLED !== 'true') return null;
  if (config.nodeEnv === 'production' || config.host !== '127.0.0.1') throw new Error('SINGLE_SCENE_DEV_ONLY');
  const local = new Set(['localhost','127.0.0.1']);
  const web = new URL(config.webOrigin), api = new URL(config.apiOrigin);
  if (!local.has(web.hostname) || web.hostname !== api.hostname) throw new Error('SINGLE_SCENE_LOCAL_ORIGIN_REQUIRED');
  let storage;
  try { storage = new URL(env.R2_ENDPOINT); } catch { throw new Error('R2_LOCAL_ENDPOINT_REQUIRED'); }
  if (storage.protocol !== 'http:' || !local.has(storage.hostname) || storage.username || storage.password || storage.pathname !== '/' || storage.search || storage.hash) throw new Error('R2_LOCAL_ENDPOINT_REQUIRED');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET || '') || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) throw new Error('R2_LOCAL_CONFIG_REQUIRED');
  // The database can only be a loopback, local replica set in this stage.
  if (!/^mongodb:\/\/(localhost|127\.0\.0\.1):27017\/[a-zA-Z0-9_-]+\?replicaSet=rs0&directConnection=true$/.test(config.mongodbUri)) throw new Error('MONGO_LOCAL_REPLICA_REQUIRED');
  return {...config, endpoint:storage.origin, bucket:env.R2_BUCKET, accessKeyId:env.R2_ACCESS_KEY_ID, secretAccessKey:env.R2_SECRET_ACCESS_KEY};
}
