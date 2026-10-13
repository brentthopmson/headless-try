import os from 'os';
import path from 'path';

// Platform-aware base for browser profile dirs and upload staging.
// Linux containers: os.tmpdir() === '/tmp' (unchanged behavior).
// Windows dev/launcher hosts: %TEMP%\... instead of C:\tmp\...
// Env overrides let a deployed box pin an absolute path if needed.
export const PROFILE_ROOT =
  process.env.WEBFIXX_PROFILE_ROOT || path.join(os.tmpdir(), 'users_data');
export const STAGING_ROOT =
  process.env.STAGING_ROOT || path.join(os.tmpdir(), 'webfixx_uploading');
