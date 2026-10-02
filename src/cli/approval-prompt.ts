/**
 * Interactive approval prompt adapter (Phase 2.3).
 *
 * The only place stdin/stdout meet the approval gate. Built on
 * node:readline/promises; injected streams keep it testable without a TTY.
 */
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ApprovalPrompt } from "../runtime/approvals/index.js";

export function createReadlineApprovalPrompt(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): ApprovalPrompt {
  return {
    async ask(text) {
      const rl = createInterface({ input, output });
      try {
        return await rl.question(text);
      } finally {
        rl.close();
      }
    },
  };
}
