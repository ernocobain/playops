/**
 * `--approve <token>` argument helper (Phase 2.3).
 *
 * Pure argv parsing for future commands and the Phase 2.6 loop. Does not
 * resolve or validate the token itself; error messages never echo tokens.
 */
import { ApprovalGateError } from "../runtime/approvals/index.js";

export interface ApproveArgument {
  readonly token: string | undefined;
  /** All arguments except the --approve flag and its value, in original order. */
  readonly rest: readonly string[];
}

const FLAG = "--approve";

export function parseApproveArgument(args: readonly string[]): ApproveArgument {
  let token: string | undefined;
  let seen = false;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    let value: string | undefined;
    if (arg === FLAG) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ApprovalGateError("CLI_ARGUMENT_INVALID", `${FLAG} requires a token value`);
      }
      value = next;
      i++;
    } else if (arg.startsWith(`${FLAG}=`)) {
      value = arg.slice(FLAG.length + 1);
    } else {
      rest.push(arg);
      continue;
    }
    if (seen) throw new ApprovalGateError("CLI_ARGUMENT_INVALID", `${FLAG} may be given only once`);
    seen = true;
    if (value.trim().length === 0) {
      throw new ApprovalGateError("CLI_ARGUMENT_INVALID", `${FLAG} token must not be blank`);
    }
    token = value.trim();
  }
  return Object.freeze({ token, rest: Object.freeze(rest) });
}
