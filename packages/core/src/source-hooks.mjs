// Passed with --import to pool workers when sforge runs from its TypeScript
// sources (tests): Node strips the types, and this hook maps the `.js`
// specifiers of the sources to their `.ts` files. Not used by the built packages.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('.') || specifier.startsWith('file:');
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !relative || !specifier.endsWith('.js')) {
        throw error;
      }
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
