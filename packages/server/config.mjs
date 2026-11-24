// Server-only configuration for the development foundation. Never import in web code.
function invalid(name) { throw new Error(`Invalid or missing configuration: ${name}`); }
function origin(value, name, production) {
  let url;
  try { url = new URL(value); } catch { invalid(name); }
  if (!['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid(name);
  return url.origin;
}
export function parseApiConfig(env) {
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) invalid('NODE_ENV');
  const production = nodeEnv === 'production';
  if (env.PUBLIC_LAUNCH_ENABLED !== undefined && env.PUBLIC_LAUNCH_ENABLED !== 'false') invalid('PUBLIC_LAUNCH_ENABLED');
  const port = Number(env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('PORT');
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1','0.0.0.0','::1','::'].includes(host)) invalid('HOST');
  if (typeof env.MONGODB_URI !== 'string' || !/^mongodb(?:\+srv)?:\/\/[^\s]+$/.test(env.MONGODB_URI)) invalid('MONGODB_URI');
  const webOrigin = origin(env.WEB_ORIGIN || (production ? '' : 'http://localhost:3000'), 'WEB_ORIGIN', production);
  const apiOrigin = origin(env.API_ORIGIN || (production ? '' : `http://localhost:${port}`), 'API_ORIGIN', production);
  return Object.freeze({ nodeEnv, host, port, webOrigin, apiOrigin, mongodbUri: env.MONGODB_URI, publicLaunchEnabled: false });
}
