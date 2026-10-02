import { describe, expect, it } from "vitest";
import {
  validateEdit,
  type AndroidPublisherClient,
  type EditsResourceLike,
  type ReviewsResourceLike,
} from "../src/googleplay/publisher/index.js";

interface Call {
  readonly params: unknown;
  readonly options: unknown;
}

function fakePublisher(
  options: {
    readonly responses?: readonly unknown[];
    readonly calls?: Call[];
  } = {},
): AndroidPublisherClient {
  const responses = [...(options.responses ?? [{ id: "edit-7", expiryTimeSeconds: "1900000000" }])];
  const calls = options.calls ?? [];
  const take = (): { data: unknown } => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return { data: value };
  };
  const edits: EditsResourceLike = {
    insert: async () => ({ data: { id: "unused", expiryTimeSeconds: "1900000000" } }),
    get: async () => ({ data: { id: "edit-7", expiryTimeSeconds: "1900000000" } }),
    validate: async (params, requestOptions) => {
      calls.push({ params, options: requestOptions });
      return take();
    },
    tracks: {
      list: async () => ({ data: { tracks: [] } }),
      get: async () => ({ data: { track: "production", releases: [] } }),
      update: async (params) => ({ data: { track: params.track, releases: [] } }),
    },
    bundles: {
      list: async () => ({ data: { bundles: [] } }),
      upload: async () => ({ data: { versionCode: 101, sha256: "a".repeat(64) } }),
    },
  };
  const reviews = {} as ReviewsResourceLike;
  return { version: "v3", reviews, edits };
}

describe("Publisher edits.validate wrapper", () => {
  it("forwards exactly packageName/editId with no body and generated retry disabled", async () => {
    const calls: Call[] = [];
    const result = await validateEdit(fakePublisher({ calls }), {
      packageName: "com.example.app",
      editId: "edit-7",
    });

    expect(calls).toEqual([
      {
        params: { packageName: "com.example.app", editId: "edit-7" },
        options: { retry: false },
      },
    ]);
    expect(result).toEqual({ id: "edit-7", expiryTimeSeconds: "1900000000" });
  });

  it("uses the bounded PlayOps read retry while keeping generated retry disabled", async () => {
    const calls: Call[] = [];
    const failure = Object.assign(new Error("PRIVATE-429-VALIDATE"), { status: 429 });
    const sleeps: number[] = [];
    const result = await validateEdit(
      fakePublisher({
        calls,
        responses: [failure, { id: "edit-7", expiryTimeSeconds: "1900000000" }],
      }),
      { packageName: "com.example.app", editId: "edit-7" },
      { sleep: async (delay) => void sleeps.push(delay), random: () => 0 },
    );

    expect(result).toEqual({ id: "edit-7", expiryTimeSeconds: "1900000000" });
    expect(calls).toHaveLength(2);
    expect(
      calls.every((call) => JSON.stringify(call.options) === JSON.stringify({ retry: false })),
    ).toBe(true);
    expect(sleeps).toHaveLength(1);
  });

  it("retries a transient 500 once within the existing read policy", async () => {
    const calls: Call[] = [];
    const failure = Object.assign(new Error("PRIVATE-500-VALIDATE"), { status: 500 });
    const result = await validateEdit(
      fakePublisher({
        calls,
        responses: [failure, { id: "edit-7", expiryTimeSeconds: "1900000000" }],
      }),
      { packageName: "com.example.app", editId: "edit-7" },
      { sleep: async () => undefined, random: () => 0 },
    );
    expect(result.id).toBe("edit-7");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.options)).toEqual([{ retry: false }, { retry: false }]);
  });

  it.each([undefined, null, {}, { id: "" }, { id: "edit-7", expiryTimeSeconds: "not-decimal" }])(
    "rejects malformed AppEdit response %j",
    async (response) => {
      await expect(
        validateEdit(fakePublisher({ responses: [response] }), {
          packageName: "com.example.app",
          editId: "edit-7",
        }),
      ).rejects.toMatchObject({ name: "PublisherError", code: "INVALID_RESPONSE" });
    },
  );

  it("rejects an AppEdit response whose id mismatches the request", async () => {
    const calls: Call[] = [];
    await expect(
      validateEdit(
        fakePublisher({
          calls,
          responses: [{ id: "edit-other", expiryTimeSeconds: "1900000000" }],
        }),
        { packageName: "com.example.app", editId: "edit-7" },
      ),
    ).rejects.toMatchObject({ name: "PublisherError", code: "INVALID_RESPONSE" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces explicit API rejection through the safe Publisher error boundary", async () => {
    const failure = Object.assign(new Error("PRIVATE-VALIDATION-DIAGNOSTICS"), { status: 400 });
    await expect(
      validateEdit(fakePublisher({ responses: [failure] }), {
        packageName: "com.example.app",
        editId: "edit-7",
      }),
    ).rejects.toMatchObject({
      name: "PublisherError",
      code: "API_REQUEST_FAILED",
      cause: failure,
    });
  });
});
