/** Machine identifiers: lowercase alphanumeric segments starting with a letter, joined by . or _. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)*$/;

export const TOOL_PERMISSION_LEVELS = Object.freeze([
  "read",
  "write",
  "destructive",
  "publish",
] as const);

export type ToolPermissionLevel = (typeof TOOL_PERMISSION_LEVELS)[number];

/** A schema adapter validates unknown data and returns its typed representation. */
export interface ToolSchema<T> {
  parse(input: unknown): T;
}

/** No runtime services are injected during Phase 2.1. */
export type ToolContext = Readonly<Record<string, never>>;

export interface ToolDefinition<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly permission: ToolPermissionLevel;
  readonly inputSchema: ToolSchema<Input>;
  readonly outputSchema: ToolSchema<Output>;
  readonly execute: (input: Input, context: ToolContext) => Promise<Output>;
  /** Optional capability only; the registry never invokes it. */
  readonly verify?: (input: Input, output: Output, context: ToolContext) => Promise<boolean>;
}

/**
 * Dynamic lookup erases the caller's input/output types. A future executor must
 * parse unknown input before invoking a retrieved handler; this registry does neither.
 */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly permission: ToolPermissionLevel;
  readonly inputSchema: ToolSchema<unknown>;
  readonly outputSchema: ToolSchema<unknown>;
  readonly execute: (input: never, context: ToolContext) => Promise<unknown>;
  readonly verify?: (input: never, output: never, context: ToolContext) => Promise<boolean>;
}

export type ToolRegistryErrorCode = "INVALID_DEFINITION" | "DUPLICATE_TOOL" | "TOOL_NOT_FOUND";

export class ToolRegistryError extends Error {
  override readonly name = "ToolRegistryError";

  constructor(
    readonly code: ToolRegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function invalid(detail: string): never {
  throw new ToolRegistryError("INVALID_DEFINITION", `Invalid tool definition: ${detail}`);
}

function hasParser(value: unknown): value is ToolSchema<unknown> {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "parse") === "function"
  );
}

function validateDefinition(value: unknown): void {
  if (typeof value !== "object" || value === null) invalid("expected an object");
  const definition = value as Record<string, unknown>;
  if (typeof definition.name !== "string" || !TOOL_NAME_PATTERN.test(definition.name)) {
    invalid("name must contain lowercase letter-led segments joined by . or _");
  }
  if (typeof definition.description !== "string" || !definition.description.trim()) {
    invalid("description must be nonblank");
  }
  if (!TOOL_PERMISSION_LEVELS.some((level) => level === definition.permission)) {
    invalid("unsupported permission level");
  }
  if (!hasParser(definition.inputSchema)) invalid("inputSchema must provide parse(input)");
  if (!hasParser(definition.outputSchema)) invalid("outputSchema must provide parse(input)");
  if (typeof definition.execute !== "function") invalid("execute must be a function");
  if (definition.verify !== undefined && typeof definition.verify !== "function") {
    invalid("verify must be a function when provided");
  }
}

/** Stores tool metadata in registration order; never executes or authorizes tools. */
export class ToolRegistry {
  readonly #definitions = new Map<string, RegisteredTool>();

  register<Input, Output>(definition: ToolDefinition<Input, Output>): void {
    validateDefinition(definition);
    if (this.#definitions.has(definition.name)) {
      throw new ToolRegistryError("DUPLICATE_TOOL", `Tool already registered: ${definition.name}`);
    }
    // Own the top-level descriptor; do not freeze schema adapters or handler functions.
    this.#definitions.set(definition.name, Object.freeze({ ...definition }));
  }

  has(name: string): boolean {
    return this.#definitions.has(name);
  }

  get(name: string): RegisteredTool {
    const definition = this.#definitions.get(name);
    if (!definition) throw new ToolRegistryError("TOOL_NOT_FOUND", "Tool not found");
    return definition;
  }

  /** Returns a frozen snapshot, ordered by registration. */
  list(): readonly RegisteredTool[] {
    return Object.freeze([...this.#definitions.values()]);
  }
}
