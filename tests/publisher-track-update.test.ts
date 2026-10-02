import { describe, expect, it } from "vitest";
import {
  PublisherError,
  updateTrack,
  type AndroidPublisherClient,
  type EditsResourceLike,
  type ReviewsResourceLike,
} from "../src/googleplay/publisher/index.js";

interface Call {
  readonly params: unknown;
  readonly options: unknown;
}

function fakePublisher(responses: unknown[] = [{ track: "production", releases: [] }]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const update = async (params: unknown, options: unknown): Promise<{ data: unknown }> => {
    calls.push({ params, options });
    const response = queue.shift();
    if (response instanceof Error) throw response;
    return { data: response };
  };
  const edits: EditsResourceLike = {
    insert: async () => ({ data: { id: "unused" } }),
    get: async () => ({ data: { id: "unused" } }),
    tracks: {
      list: async () => ({ data: { tracks: [] } }),
      get: async () => ({ data: { track: "production", releases: [] } }),
      update,
    },
    bundles: {
      list: async () => ({ data: { bundles: [] } }),
      upload: async () => ({ data: { versionCode: 1, sha256: "0".repeat(64) } }),
    },
  };
  return {
    client: {
      version: "v3",
      reviews: {} as ReviewsResourceLike,
      edits,
    } as AndroidPublisherClient,
    calls,
    update,
  };
}

const input = {
  packageName: "com.example.app",
  editId: "edit-7",
  track: "wear:production",
  requestBody: {
    track: "wear:production",
    releases: [
      {
        name: "Candidate 101",
        versionCodes: ["100", "101"],
        status: "inProgress",
        userFraction: 0.05,
      },
    ],
  },
};

describe("Publisher edits.tracks.update wrapper", () => {
  it("uses the exact package/edit/track/body and disables generated retry", async () => {
    const fake = fakePublisher([{ track: "wear:production", releases: [] }]);

    const result = await updateTrack(fake.client, input);

    expect(fake.calls).toEqual([
      {
        params: input,
        options: { retry: false },
      },
    ]);
    expect(result).toEqual({ track: "wear:production", releases: [] });
  });

  it.each([
    [429, "throttled"],
    [500, "server"],
    [undefined, "network"],
  ])("does not retry a %s/update failure", async (status, marker) => {
    const failure = Object.assign(new Error(`PRIVATE-${marker}`), status ? { status } : {});
    const fake = fakePublisher([failure]);

    await expect(updateTrack(fake.client, input)).rejects.toMatchObject({
      name: "PublisherError",
      code: "API_REQUEST_FAILED",
      cause: failure,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options).toEqual({ retry: false });
  });

  it.each([
    undefined,
    null,
    {},
    { track: "production" },
    { track: "wear:production", releases: "bad" },
  ])("rejects malformed update response %j without retry", async (response) => {
    const fake = fakePublisher([response]);

    await expect(updateTrack(fake.client, input)).rejects.toMatchObject({
      name: "PublisherError",
      code: "INVALID_RESPONSE",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects a response for a different track with a safe identity reason", async () => {
    const fake = fakePublisher([{ track: "production", releases: [] }]);

    await expect(updateTrack(fake.client, input)).rejects.toMatchObject({
      name: "PublisherError",
      code: "INVALID_RESPONSE",
      reason: "TRACK_IDENTITY_MISMATCH",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects invalid inputs before calling the generated client", async () => {
    const fake = fakePublisher();

    await expect(updateTrack(fake.client, { ...input, packageName: " " })).rejects.toBeInstanceOf(
      PublisherError,
    );
    await expect(updateTrack(fake.client, { ...input, editId: " " })).rejects.toBeInstanceOf(
      PublisherError,
    );
    await expect(updateTrack(fake.client, { ...input, track: " " })).rejects.toBeInstanceOf(
      PublisherError,
    );
    expect(fake.calls).toHaveLength(0);
  });
});
