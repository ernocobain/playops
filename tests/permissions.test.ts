import { describe, expect, it, vi } from "vitest";
import {
  evaluateToolPermission,
  type ApprovalRecord,
  type PermissionDecision,
} from "../src/runtime/permissions/index.js";
import {
  ToolRegistry,
  type RegisteredTool,
  type ToolDefinition,
  type ToolPermissionLevel,
  type ToolSchema,
} from "../src/runtime/tools/index.js";

const textSchema: ToolSchema<string> = {
  parse(input) {
    if (typeof input !== "string") throw new TypeError("Expected text");
    return input;
  },
};

interface FakeToolHandles {
  tool: RegisteredTool;
  execute: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  registry: ToolRegistry;
}

function registerFakeTool(name: string, permission: ToolPermissionLevel): FakeToolHandles {
  const execute = vi.fn((input: string) => Promise.resolve(input));
  const verify = vi.fn(() => Promise.resolve(true));
  const definition: ToolDefinition<string, string> = {
    name,
    description: `Fake ${permission} tool`,
    permission,
    inputSchema: textSchema,
    outputSchema: textSchema,
    execute,
    verify,
  };
  const registry = new ToolRegistry();
  registry.register(definition);
  return { tool: registry.get(name), execute, verify, registry };
}

function approved(toolName: string, permission: ToolPermissionLevel): ApprovalRecord {
  return { toolName, permission, decision: "approved" };
}

function denied(toolName: string, permission: ToolPermissionLevel): ApprovalRecord {
  return { toolName, permission, decision: "denied" };
}

function expectDecision(
  decision: PermissionDecision,
  expected: Pick<PermissionDecision, "allowed" | "code">,
): void {
  expect(decision.allowed).toBe(expected.allowed);
  expect(decision.code).toBe(expected.code);
}

describe("evaluateToolPermission — read", () => {
  it("allows a read tool without approval", () => {
    const { tool } = registerFakeTool("test.read", "read");
    const decision = evaluateToolPermission(tool);
    expectDecision(decision, { allowed: true, code: "ALLOWED" });
    expect(decision.requiresApproval).toBe(false);
  });

  it("ignores an irrelevant approval for a read tool", () => {
    const { tool } = registerFakeTool("test.read", "read");
    expectDecision(evaluateToolPermission(tool, denied("test.read", "read")), {
      allowed: true,
      code: "ALLOWED",
    });
    expectDecision(evaluateToolPermission(tool, approved("test.other", "publish")), {
      allowed: true,
      code: "ALLOWED",
    });
  });
});

describe("evaluateToolPermission — write", () => {
  it("allows a write tool without approval", () => {
    const { tool } = registerFakeTool("test.write", "write");
    const decision = evaluateToolPermission(tool);
    expectDecision(decision, { allowed: true, code: "ALLOWED" });
    expect(decision.requiresApproval).toBe(false);
  });

  it("ignores an irrelevant approval for a write tool", () => {
    const { tool } = registerFakeTool("test.write", "write");
    expectDecision(evaluateToolPermission(tool, denied("test.write", "write")), {
      allowed: true,
      code: "ALLOWED",
    });
  });
});

describe.each(["destructive", "publish"] as const)("evaluateToolPermission — %s", (permission) => {
  const name = `test.${permission}`;
  const otherPermission: ToolPermissionLevel =
    permission === "destructive" ? "publish" : "destructive";

  it("denies without approval as APPROVAL_REQUIRED", () => {
    const { tool } = registerFakeTool(name, permission);
    const decision = evaluateToolPermission(tool);
    expectDecision(decision, { allowed: false, code: "APPROVAL_REQUIRED" });
    expect(decision.requiresApproval).toBe(true);
  });

  it("allows with an exactly matching approved record", () => {
    const { tool } = registerFakeTool(name, permission);
    const decision = evaluateToolPermission(tool, approved(name, permission));
    expectDecision(decision, { allowed: true, code: "ALLOWED" });
    expect(decision.requiresApproval).toBe(true);
  });

  it("denies an explicitly denied record as APPROVAL_DENIED", () => {
    const { tool } = registerFakeTool(name, permission);
    expectDecision(evaluateToolPermission(tool, denied(name, permission)), {
      allowed: false,
      code: "APPROVAL_DENIED",
    });
  });

  it("denies an approval issued for a different tool", () => {
    const { tool } = registerFakeTool(name, permission);
    expectDecision(evaluateToolPermission(tool, approved("test.someone_else", permission)), {
      allowed: false,
      code: "INVALID_APPROVAL",
    });
  });

  it("denies an approval issued for a different permission level", () => {
    const { tool } = registerFakeTool(name, permission);
    expectDecision(evaluateToolPermission(tool, approved(name, otherPermission)), {
      allowed: false,
      code: "INVALID_APPROVAL",
    });
  });
});

describe("evaluateToolPermission — fail closed", () => {
  it.each([
    null,
    "approved",
    42,
    {},
    { toolName: "test.publish", permission: "publish" },
    { toolName: "test.publish", permission: "publish", decision: "yes" },
    { toolName: "test.publish", permission: "publish", decision: "APPROVED" },
    { toolName: "", permission: "publish", decision: "approved" },
    { toolName: "test.publish", permission: "admin", decision: "approved" },
  ])("denies malformed approval %j from an untyped boundary", (malformed) => {
    const { tool } = registerFakeTool("test.publish", "publish");
    const decision = evaluateToolPermission(tool, malformed as unknown as ApprovalRecord);
    expect(decision.allowed).toBe(false);
    expect(["INVALID_APPROVAL", "APPROVAL_REQUIRED"]).toContain(decision.code);
  });

  it("denies an unsupported permission value from an untyped boundary", () => {
    const { tool } = registerFakeTool("test.read", "read");
    const tampered = { ...tool, permission: "admin" } as unknown as RegisteredTool;
    const decision = evaluateToolPermission(tampered, approved("test.read", "read"));
    expectDecision(decision, { allowed: false, code: "INVALID_PERMISSION" });
    expect(decision.requiresApproval).toBe(true);
  });

  it.each(["", "   ", undefined, 7])("denies a tool with unusable name %j", (badName) => {
    const { tool } = registerFakeTool("test.read", "read");
    const tampered = { ...tool, name: badName } as unknown as RegisteredTool;
    const decision = evaluateToolPermission(tampered);
    expectDecision(decision, { allowed: false, code: "INVALID_PERMISSION" });
    expect(decision.toolName).toBe("");
  });

  it("denies a non-object tool from an untyped boundary", () => {
    const decision = evaluateToolPermission(null as unknown as RegisteredTool);
    expectDecision(decision, { allowed: false, code: "INVALID_PERMISSION" });
  });
});

describe("evaluateToolPermission — behavior", () => {
  it("echoes toolName and permission in the decision", () => {
    const { tool } = registerFakeTool("test.publish", "publish");
    const decision = evaluateToolPermission(tool);
    expect(decision.toolName).toBe("test.publish");
    expect(decision.permission).toBe("publish");
  });

  it("never invokes execute or verify handlers during evaluation", () => {
    for (const permission of ["read", "write", "destructive", "publish"] as const) {
      const { tool, execute, verify } = registerFakeTool(`test.${permission}`, permission);
      evaluateToolPermission(tool);
      evaluateToolPermission(tool, approved(`test.${permission}`, permission));
      evaluateToolPermission(tool, denied(`test.${permission}`, permission));
      expect(execute).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    }
  });

  it("does not mutate the tool, approval, or registry", () => {
    const { tool, registry } = registerFakeTool("test.destructive", "destructive");
    const approval = approved("test.destructive", "destructive");
    const toolSnapshot = { ...tool };
    const approvalSnapshot = structuredClone(approval);
    const listBefore = registry.list().map((entry) => entry.name);

    evaluateToolPermission(tool, approval);

    expect({ ...tool }).toEqual(toolSnapshot);
    expect(approval).toEqual(approvalSnapshot);
    expect(registry.list().map((entry) => entry.name)).toEqual(listBefore);
    expect(registry.get("test.destructive")).toBe(tool);
  });

  it("returns a frozen decision", () => {
    const { tool } = registerFakeTool("test.read", "read");
    const decision = evaluateToolPermission(tool);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const { tool } = registerFakeTool("test.publish", "publish");
    const approval = approved("test.publish", "publish");
    const first = evaluateToolPermission(tool, approval);
    const second = evaluateToolPermission(tool, approval);
    expect(second).toEqual(first);
    expect(evaluateToolPermission(tool)).toEqual(evaluateToolPermission(tool));
  });
});
