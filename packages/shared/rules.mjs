// Shared public MVP rules. Server must enforce these independently of client input.
export const GAME_RULES = Object.freeze({
  "sceneCount": 5,
  "sceneSeconds": 3,
  "width": 720,
  "height": 1280,
  "fps": 30,
  "sourceMinSeconds": 2.7,
  "sourceMaxSeconds": 3.5,
  "maxUploadBytes": 12582912,
  "collectLifetimeMs": 604800000,
  "readyLifetimeMs": 604800000,
  "inviteLifetimeMs": 86400000,
  "turnLifetimeMs": 1800000
});
export const MOVIE_STATUS = Object.freeze(["collecting","assembling","ready","failed","deleting","deleted","expired"]);
export const SLOT_STATUS = Object.freeze(["locked","open","claimed","uploading","queued","accepted","retryable"]);
function deriveOutput(r) {return Object.freeze({sceneFrames:r.sceneSeconds*r.fps,movieSeconds:r.sceneCount*r.sceneSeconds,movieFrames:r.sceneCount*r.sceneSeconds*r.fps});}
export const OUTPUT = deriveOutput(GAME_RULES);
