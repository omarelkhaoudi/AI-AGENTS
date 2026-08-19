export const AUTH_MODES = Object.freeze(["token", "demo"]);

export class SecurityConfigurationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SecurityConfigurationError";
    this.code = "SECURITY_CONFIGURATION_ERROR";
    this.details = details;
  }
}
