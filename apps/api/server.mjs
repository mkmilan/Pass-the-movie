import mongoose from 'mongoose';
import { parseApiConfig } from '../../packages/server/config.mjs';
import { createApp } from './app.mjs';
import { singleSceneConfig } from '../../packages/server/single-scene-config.mjs';
import { sceneCollections, ensureSceneIndexes } from '../../packages/server/scene-db.mjs';
import { createStorage } from '../../packages/server/storage.mjs';

async function start() {
  const config = parseApiConfig(process.env);
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
  const local = singleSceneConfig(process.env);
  let scene = null;
  if (local) {
    const collections = sceneCollections(mongoose.connection.db);
    await ensureSceneIndexes(collections);
    const storage = createStorage(local);
    await storage.ready();
    scene = { config: local, collections, client: mongoose.connection.getClient(), storage };
  }
  const app = createApp(scene);
  const server = app.listen(config.port, config.host, () => console.log('API health endpoint listening'));
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on('error', async () => {
    console.error('API_LISTEN_FAILED');
    scene?.storage.close();
    await mongoose.disconnect();
    process.exitCode = 1;
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(async () => {
      try { scene?.storage.close(); await mongoose.disconnect(); }
      catch { process.exitCode = 1; }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
start().catch(async () => {
  console.error('API_STARTUP_FAILED: check local database and environment configuration');
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
