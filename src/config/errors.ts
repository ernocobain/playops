/**
 * Typed configuration error (Phase 0.5).
 *
 * Raised for malformed YAML, wrong value types, or invalid values.
 * Missing optional config file is NOT an error (defaults apply);
 * an explicitly supplied config path that does not exist IS an error.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(
    message: string,
    readonly code:
      | "CONFIG_NOT_FOUND"
      | "CONFIG_MALFORMED_YAML"
      | "CONFIG_INVALID_TYPE"
      | "CONFIG_INVALID_VALUE"
      | "CONFIG_MIGRATION_REQUIRED",
  ) {
    super(message);
  }
}
