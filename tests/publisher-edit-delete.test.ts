import { describe, expect, it } from "vitest";
import {
  deleteEdit,
  type AndroidPublisherClient,
  type EditsResourceLike,
  type ReviewsResourceLike,
} from "../src/googleplay/publisher/index.js";

const packageName = "com.example.release";
const editId = "temporary-readback-edit";

describe("edits.delete Publisher wrapper", () => {
  it("sends exact package/edit identity once with empty-body request options and no retry", async () => {
    const calls: { params: unknown; options: unknown }[] = [];
    const edits = {
      insert: async () => ({ data: {} }),
      delete: async (params: unknown, options: unknown) => {
        calls.push({ params, options });
        return { data: {} };
      },
      get: async () => ({ data: {} }),
      tracks: {
        list: async () => ({ data: {} }),
        get: async () => ({ data: {} }),
        update: async () => ({ data: {} }),
      },
      bundles: { list: async () => ({ data: {} }), upload: async () => ({ data: {} }) },
    } as unknown as EditsResourceLike;
    const client = {
      version: "v3",
      reviews: {} as ReviewsResourceLike,
      edits,
    } as AndroidPublisherClient;

    await expect(deleteEdit(client, { packageName, editId })).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        params: { packageName, editId },
        options: { retry: false },
      },
    ]);
  });

  it("does not retry a failed cleanup", async () => {
    let calls = 0;
    const edits = {
      insert: async () => ({ data: {} }),
      delete: async () => {
        calls += 1;
        throw Object.assign(new Error("PRIVATE-DELETE-500"), { status: 500 });
      },
      get: async () => ({ data: {} }),
      tracks: {
        list: async () => ({ data: {} }),
        get: async () => ({ data: {} }),
        update: async () => ({ data: {} }),
      },
      bundles: { list: async () => ({ data: {} }), upload: async () => ({ data: {} }) },
    } as unknown as EditsResourceLike;
    const client = {
      version: "v3",
      reviews: {} as ReviewsResourceLike,
      edits,
    } as AndroidPublisherClient;

    await expect(deleteEdit(client, { packageName, editId })).rejects.toMatchObject({
      code: "API_REQUEST_FAILED",
      externalStateUncertain: true,
    });
    expect(calls).toBe(1);
  });
});
