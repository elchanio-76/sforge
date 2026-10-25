import type { Provider } from '@staticforge/provider-api';
import { type AzureClients, defaultClients } from './clients.js';
import { REQUIRED_OUTPUTS, createAzureDeployer } from './deployer.js';
import { createAzureIacProfile } from './iac.js';

export * from './clients.js';
export * from './cname.js';
export * from './deployer.js';
export * from './history.js';
export * from './iac.js';
export * from './rebuild.js';
export * from './swa-config.js';
export * from './uploader.js';

/** The Azure provider: Static Web Apps, named preview environments, rollback by rebuild. */
export function createAzureProvider(clients: AzureClients = defaultClients()): Provider {
  return {
    id: 'azure',
    iac: createAzureIacProfile(clients),
    createDeployer: (context) => createAzureDeployer(context, clients),
    requiredOutputs: REQUIRED_OUTPUTS,
  };
}
