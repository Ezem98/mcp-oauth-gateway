import { getEnv } from "../config/env.js";

/**
 * Identity provider abstraction.
 *
 * Spike ships only the demo provider. A real `OidcIdentityProvider` that
 * delegates to Google/GitHub will be added later behind a feature flag,
 * implementing the same shape.
 */
export interface AuthenticatedUser {
  subject: string;
  email?: string;
  display_name?: string;
}

export interface IdentityProvider {
  /**
   * Resolves the user the consent screen will authenticate as.
   * For the demo provider this is hardcoded; a real provider would read a
   * session cookie or initiate an upstream OAuth dance.
   */
  resolveUser(): Promise<AuthenticatedUser>;
}

export class DemoIdentityProvider implements IdentityProvider {
  async resolveUser(): Promise<AuthenticatedUser> {
    const email = getEnv().AUTH_DEFAULT_USER;
    return {
      subject: email,
      email,
      display_name: email,
    };
  }
}

let _provider: IdentityProvider | null = null;
export function getIdentityProvider(): IdentityProvider {
  if (_provider) return _provider;
  _provider = new DemoIdentityProvider();
  return _provider;
}
