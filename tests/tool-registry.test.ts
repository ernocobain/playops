import { describe, expect, it, vi } from "vitest";
import {
  TOOL_PERMISSION_LEVELS,
  ToolRegistry,
  ToolRegistryError,
  type ToolDefinition,
  type ToolSchema,
} from "../src/runtime/tools/index.js";

const textSchema: ToolSchema<string> = {
  parse(input) {
    if (typeof input !== "string") throw new TypeError("Expected text");
    return input;
  },
};

function fakeTool(
  overrides: Partial<ToolDefinition<string, string>> = {},
): ToolDefinition<string, string> {
  return {
    name: "test.echo",
    description: "Echo a fake value",
    permission: "read",
    inputSchema: textSchema,
    outputSchema: textSchema,
    execute: (input) => Promise.resolve(input),
    ...overrides,
  };
}

function expectRegistryError(action: () => void, code: ToolRegistryError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRegistryError);
    expect((error as ToolRegistryError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("ToolRegistry definitions", () => {
  it.each(TOOL_PERMISSION_LEVELS)("accepts a %s tool", (permission) => {
    const registry = new ToolRegistry();
    const definition = fakeTool({ permission });
    registry.register(definition);
    expect(registry.get("test.echo").permission).toBe(permission);
  });

  it.each(["", " ", "\t", "\n"])("rejects blank name %j", (name) => {
    expectRegistryError(
      () => new ToolRegistry().register(fakeTool({ name })),
      "INVALID_DEFINITION",
    );
  });

  it.each(["Test.echo", "test echo", "test..echo", ".test", "test_", "test/echo", "test.9echo"])(
    "rejects name outside lowercase dot/underscore grammar: %s",
    (name) => {
      expectRegistryError(
        () => new ToolRegistry().register(fakeTool({ name })),
        "INVALID_DEFINITION",
      );
    },
  );

  it("accepts lowercase underscore and dot segments", () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool({ name: "test_read.echo2" }));
    expect(registry.has("test_read.echo2")).toBe(true);
  });

  it.each(["", " ", "\t"])("rejects blank description %j", (description) => {
    expectRegistryError(
      () => new ToolRegistry().register(fakeTool({ description })),
      "INVALID_DEFINITION",
    );
  });

  it("rejects unsupported permission from an untyped caller", () => {
    const unsafeDefinition = { ...fakeTool(), permission: "admin" } as unknown as ToolDefinition<
      string,
      string
    >;
    expectRegistryError(() => new ToolRegistry().register(unsafeDefinition), "INVALID_DEFINITION");
  });

  it("rejects malformed definitions and missing schema/handler boundaries", () => {
    for (const definition of [
      null,
      { ...fakeTool(), inputSchema: undefined },
      { ...fakeTool(), outputSchema: { parse: 1 } },
      { ...fakeTool(), execute: "not a function" },
      { ...fakeTool(), verify: null },
    ]) {
      expectRegistryError(
        () => new ToolRegistry().register(definition as unknown as ToolDefinition<string, string>),
        "INVALID_DEFINITION",
      );
    }
  });
});

describe("ToolRegistry storage", () => {
  it("registers, finds, and gets a tool", () => {
    const registry = new ToolRegistry();
    expect(registry.has("test.echo")).toBe(false);
    registry.register(fakeTool());
    expect(registry.has("test.echo")).toBe(true);
    expect(registry.get("test.echo").description).toBe("Echo a fake value");
  });

  it("rejects an unknown lookup with a typed TOOL_NOT_FOUND error", () => {
    const registry = new ToolRegistry();
    expectRegistryError(() => registry.get("test.unknown"), "TOOL_NOT_FOUND");
  });

  it("rejects a duplicate and preserves the first definition", () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool());
    expectRegistryError(
      () => registry.register(fakeTool({ description: "replacement" })),
      "DUPLICATE_TOOL",
    );
    expect(registry.get("test.echo").description).toBe("Echo a fake value");
  });

  it("lists all definitions in registration order, consistently", () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool({ name: "test.z" }));
    registry.register(fakeTool({ name: "test.a", permission: "write" }));
    expect(registry.list().map((tool) => tool.name)).toEqual(["test.z", "test.a"]);
    expect(registry.list().map((tool) => tool.name)).toEqual(["test.z", "test.a"]);
  });

  it("does not expose a mutable registry collection or descriptor", () => {
    const registry = new ToolRegistry();
    const original = fakeTool();
    registry.register(original);
    Object.assign(original, { name: "test.changed" });
    expect(registry.has("test.echo")).toBe(true);
    expect(registry.has("test.changed")).toBe(false);
    const listed = registry.list();
    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => (listed as unknown[]).push(fakeTool({ name: "test.other" }))).toThrow();
    expect(() => Object.assign(registry.get("test.echo"), { name: "test.other" })).toThrow();
    expect(registry.list().map((tool) => tool.name)).toEqual(["test.echo"]);
  });

  it("keeps registry instances independent", () => {
    const first = new ToolRegistry();
    const second = new ToolRegistry();
    first.register(fakeTool());
    expect(second.has("test.echo")).toBe(false);
    expect(second.list()).toEqual([]);
  });

  it("does not parse input or execute a handler during registration or lookup", () => {
    const inputSchema = { parse: vi.fn(() => "value") };
    const execute = vi.fn(() => Promise.resolve("value"));
    const registry = new ToolRegistry();
    registry.register(fakeTool({ inputSchema, execute }));
    registry.get("test.echo");
    registry.list();
    expect(inputSchema.parse).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("tool schema and handler contracts", () => {
  it("parses valid input and output through the PlayOps-owned schema contract", async () => {
    const definition = fakeTool();
    const input = definition.inputSchema.parse("hello");
    const output = await definition.execute(input, {});
    expect(definition.outputSchema.parse(output)).toBe("hello");
  });

  it("propagates a schema failure without executing the handler", async () => {
    const execute = vi.fn((value: string) => Promise.resolve(value));
    const definition = fakeTool({ execute });
    const failure = new TypeError("Expected text");
    const inputSchema: ToolSchema<string> = {
      parse: () => {
        throw failure;
      },
    };
    const registry = new ToolRegistry();
    registry.register({ ...definition, inputSchema });
    await expect(
      (async () => {
        const parsed = inputSchema.parse(42);
        return definition.execute(parsed, {});
      })(),
    ).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
  });

  it("models an optional async verifier without automatically running it", async () => {
    const verify = vi.fn((input: string, output: string) => Promise.resolve(input === output));
    const registry = new ToolRegistry();
    registry.register(fakeTool({ permission: "write", verify }));
    expect(typeof registry.get("test.echo").verify).toBe("function");
    expect(verify).not.toHaveBeenCalled();
    expect(await verify("a", "a")).toBe(true);
  });

  it("allows read and mutating definitions without a verifier in Phase 2.1", () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool({ name: "test.read" }));
    registry.register(fakeTool({ name: "test.write", permission: "write" }));
    expect(registry.get("test.read").verify).toBeUndefined();
    expect(registry.get("test.write").verify).toBeUndefined();
  });
});
