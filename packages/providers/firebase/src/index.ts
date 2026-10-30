import type { Provider } from '@staticforge/provider-api';
import { type FirebaseClients, defaultClients } from './client.js';
import { REQUIRED_OUTPUTS, createFirebaseDeployer } from './deployer.js';
import { createFirebaseIacProfile } from './iac.js';

export * from './client.js';
export * from './deployer.js';
export * from './iac.js';
export * from './serving-config.js';

/** The Firebase provider: Firebase Hosting, preview channels, rollback by release. Public sites only. */
export function createFirebaseProvider(clients: FirebaseClients = defaultClients()): Provider {
  return {
    id: 'firebase',
    iac: createFirebaseIacProfile(clients),
    createDeployer: (context) => createFirebaseDeployer(context, clients),
    requiredOutputs: REQUIRED_OUTPUTS,
  };
}
