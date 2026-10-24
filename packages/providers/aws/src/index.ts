import type { Provider } from '@staticforge/provider-api';
import { type AwsClients, defaultClients } from './clients.js';
import { REQUIRED_OUTPUTS, createAwsDeployer } from './deployer.js';
import { createAwsIacProfile } from './iac.js';

export * from './clients.js';
export * from './deployer.js';
export * from './iac.js';
export * from './routing.js';

/** The AWS provider: private S3 + CloudFront with OAC, versions in a KeyValueStore. */
export function createAwsProvider(clients: AwsClients = defaultClients()): Provider {
  return {
    id: 'aws',
    iac: createAwsIacProfile(clients),
    createDeployer: (context) => createAwsDeployer(context, clients),
    requiredOutputs: REQUIRED_OUTPUTS,
  };
}
