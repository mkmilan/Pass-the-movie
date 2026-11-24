import mongoose from 'mongoose';
import { parseApiConfig } from '../../packages/server/config.mjs';
import { createApp } from './app.mjs';

async function start() {
  const config = parseApiConfig(process.env);
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
  const app = createApp();
  const server = app.listen(config.port, config.host, () => console.log('API health endpoint listening'));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on('error', async () => {
    console.error('API_LISTEN_FAILED');
    await mongoose.disconnect();
    process.exitCode = 1;
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(async () => {
      try { await mongoose.disconnect(); }
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
