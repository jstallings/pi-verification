// Optional fallback for development against an already-installed Pi, without installs.
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.PI_VERIFICATION_HOST_ROOT) {
  const parentURL = pathToFileURL(resolve(process.env.PI_VERIFICATION_HOST_ROOT, '__verification__.mjs')).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || (!specifier.startsWith('@earendil-works/') && !specifier.startsWith('typebox'))) throw error;
        return nextResolve(specifier, { ...context, parentURL });
      }
    },
  });
}
