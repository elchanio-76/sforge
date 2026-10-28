import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminUserGlobalSignOutCommand,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { type AwsTargetConfig, ErrorCode, SforgeError } from '@staticforge/core';
import type {
  DeployerContext,
  InviteOptions,
  InviteResult,
  SiteUser,
  UserAdmin,
} from '@staticforge/provider-api';
import { type AwsClients, awsError, defaultClients, errorName } from './clients.js';
import { rotateSessionKey, sessionKeyLocation } from './session.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toSiteUser(user: UserType): SiteUser {
  const attribute = (name: string) => user.Attributes?.find((a) => a.Name === name)?.Value;
  return {
    id: attribute('sub') ?? user.Username ?? '',
    name: attribute('email') ?? user.Username ?? '',
    ...(user.UserStatus !== undefined && { status: user.UserStatus }),
    ...(user.Enabled !== undefined && { enabled: user.Enabled }),
    ...(user.UserCreateDate !== undefined && { createdAt: user.UserCreateDate.toISOString() }),
  };
}

/**
 * Users of a private AWS target, in its Cognito user pool. Cognito emails each
 * invited user a temporary password (its default sender allows 50 emails a day).
 */
export function createAwsUserAdmin(
  context: DeployerContext,
  clients: AwsClients = defaultClients(),
): UserAdmin {
  const target = context.target as AwsTargetConfig;
  const name = context.targetName;

  function poolId(): string {
    if (target.auth === undefined) {
      throw new SforgeError(ErrorCode.Unsupported, `Target "${name}" is not private`, {
        hint: `Set targets.${name}.auth and run \`sforge provision ${name}\`.`,
      });
    }
    const id = context.outputs.auth_user_pool_id;
    if (typeof id !== 'string' || id === '') {
      throw new SforgeError(ErrorCode.NotProvisioned, `Target "${name}" has no user pool yet`, {
        hint: `Run \`sforge provision ${name}\`.`,
      });
    }
    return id;
  }
  const cognito = () => clients.cognito(target.region);

  async function list(filter?: string): Promise<UserType[]> {
    const users: UserType[] = [];
    let token: string | undefined;
    do {
      const page = await cognito().send(
        new ListUsersCommand({
          UserPoolId: poolId(),
          ...(filter !== undefined && { Filter: filter }),
          ...(token !== undefined && { PaginationToken: token }),
        }),
      );
      users.push(...(page.Users ?? []));
      token = page.PaginationToken;
    } while (token !== undefined);
    return users;
  }

  return {
    async list() {
      try {
        return (await list()).map(toSiteUser);
      } catch (error) {
        throw awsError(error, `Could not list the users of "${name}"`);
      }
    },

    async invite(options: InviteOptions): Promise<InviteResult> {
      const email = options.user.trim().toLowerCase();
      if (email.length > 254 || !EMAIL.test(email)) {
        throw new SforgeError(ErrorCode.Usage, `"${options.user}" is not an email address`, {
          hint: 'Users of AWS targets sign in with their email address.',
        });
      }
      if (options.provider !== undefined) {
        throw new SforgeError(ErrorCode.Usage, 'AWS targets have no sign-in providers to choose');
      }
      try {
        await cognito().send(
          new AdminCreateUserCommand({
            UserPoolId: poolId(),
            Username: email,
            UserAttributes: [
              { Name: 'email', Value: email },
              // The invitation proves the address once the user signs in with it.
              { Name: 'email_verified', Value: 'true' },
            ],
            DesiredDeliveryMediums: ['EMAIL'],
          }),
        );
      } catch (error) {
        if (errorName(error) === 'UsernameExistsException') {
          throw new SforgeError(ErrorCode.UserExists, `${email} is already a user of "${name}"`);
        }
        throw awsError(error, `Could not invite ${email}`);
      }
      return { user: email, emailed: true };
    },

    async remove(user: string): Promise<boolean> {
      const email = user.trim().toLowerCase();
      try {
        const found = await list(`email = "${email.replace(/["\\]/g, '')}"`);
        for (const entry of found) {
          // Signs out of Cognito; the site's session cookie lasts until it expires.
          await cognito().send(
            new AdminUserGlobalSignOutCommand({ UserPoolId: poolId(), Username: entry.Username }),
          );
          await cognito().send(
            new AdminDeleteUserCommand({ UserPoolId: poolId(), Username: entry.Username }),
          );
        }
        return found.length > 0;
      } catch (error) {
        throw awsError(error, `Could not remove ${email}`);
      }
    },

    async revokeSessions() {
      poolId();
      const location = sessionKeyLocation(context.outputs, target.region);
      if (location === undefined) {
        throw new SforgeError(ErrorCode.NotProvisioned, `Target "${name}" has no session key yet`, {
          hint: `Run \`sforge provision ${name}\`.`,
        });
      }
      try {
        await rotateSessionKey(clients, location);
      } catch (error) {
        throw awsError(error, `Could not replace the session key of "${name}"`);
      }
    },
  };
}
