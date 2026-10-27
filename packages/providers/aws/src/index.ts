import type { Provider } from '@staticforge/provider-api';
import { type AwsClients, defaultClients } from './clients.js';
import { REQUIRED_OUTPUTS, createAwsDeployer } from './deployer.js';
import { createAwsIacProfile } from './iac.js';
import { createAwsUserAdmin } from './users.js';

export * from './clients.js';
export * from './deployer.js';
export * from './iac.js';
export * from './routing.js';
export * from './session.js';
export * from './users.js';

/**
 * The AWS provider: private S3 + CloudFront with OAC, versions in a KeyValueStore,
 * and for private targets sign-in with a Cognito user pool.
 */
export function createAwsProvider(clients: AwsClients = defaultClients()): Provider {
  return {
    id: 'aws',
    iac: createAwsIacProfile(clients),
    createDeployer: (context) => createAwsDeployer(context, clients),
    requiredOutputs: REQUIRED_OUTPUTS,
    createUserAdmin: (context) => createAwsUserAdmin(context, clients),
  };
}
