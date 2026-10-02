import { describe, expect, it } from "vitest";
import {
  createEdit,
  getEdit,
  getTrack,
  listTracks,
  PublisherError,
  type AndroidPublisherClient,
  type EditsResourceLike,
  type ReviewsResourceLike,
} from "../src/googleplay/publisher/index.js";

interface Call {
  readonly params: unknown;
  readonly options: unknown;
}
interface FakePublisherState {
  readonly calls: {
    insert: Call[];
    getEdit: Call[];
    listTracks: Call[];
    getTrack: Call[];
  };
  readonly responses: {
    insert: unknown[];
    getEdit: unknown[];
    listTracks: unknown[];
    getTrack: unknown[];
  };
}

function take(queue: unknown[]): { data: unknown } {
  const value = queue.shift();
  if (value instanceof Error) throw value;
  return { data: value };
}

function fakePublisher(responses: Partial<FakePublisherState["responses"]> = {}): {
  readonly client: AndroidPublisherClient;
  readonly state: FakePublisherState;
} {
  const state: FakePublisherState = {
    calls: { insert: [], getEdit: [], listTracks: [], getTrack: [] },
    responses: {
      insert: responses.insert ?? [{ id: "edit-7", expiryTimeSeconds: "1900000000" }],
      getEdit: responses.getEdit ?? [{ id: "edit-7", expiryTimeSeconds: "1900000000" }],
      listTracks: responses.listTracks ?? [{ tracks: [] }],
      getTrack: responses.getTrack ?? [{ track: "production", releases: [] }],
    },
  };
  const recordCall = (
    kind: keyof FakePublisherState["calls"],
    params: unknown,
    options: unknown,
  ) => {
    state.calls[kind].push({ params, options });
  };
  const edits: EditsResourceLike = {
    insert: async (params, options) => {
      recordCall("insert", params, options);
      return take(state.responses.insert);
    },
    get: async (params, options) => {
      recordCall("getEdit", params, options);
      return take(state.responses.getEdit);
    },
    tracks: {
      list: async (params, options) => {
        recordCall("listTracks", params, options);
        return take(state.responses.listTracks);
      },
      get: async (params, options) => {
        recordCall("getTrack", params, options);
        return take(state.responses.getTrack);
      },
      update: async (params) => ({
        data: {
          track: params.track,
          releases: [],
        },
      }),
    },
    bundles: {
      list: async () => ({ data: { bundles: [] } }),
      upload: async () => ({ data: { versionCode: 1, sha256: "0".repeat(64) } }),
    },
  };
  const reviews = {} as ReviewsResourceLike;
  return {
    client: { version: "v3", reviews, edits } as AndroidPublisherClient,
    state,
  };
}

describe("Publisher Edits API read foundation", () => {
  it("creates one edit with packageName, retry:false, and lossless expiry", async () => {
    const { client, state } = fakePublisher();

    const edit = await createEdit(client, { packageName: "com.example.app" });

    expect(state.calls.insert).toEqual([
      { params: { packageName: "com.example.app" }, options: { retry: false } },
    ]);
    expect(edit).toEqual({ id: "edit-7", expiryTimeSeconds: "1900000000" });
  });

  it.each([
    [429, "throttled"],
    [500, "server-failed"],
    [undefined, "network-ambiguous"],
  ])("does not retry edits.insert after %s failure", async (status, marker) => {
    const failure = Object.assign(new Error(`PRIVATE-${marker}`), status ? { status } : {});
    const { client, state } = fakePublisher({ insert: [failure] });

    await expect(createEdit(client, { packageName: "com.example.app" })).rejects.toMatchObject({
      name: "PublisherError",
      code: "API_REQUEST_FAILED",
      cause: failure,
    });
    expect(state.calls.insert).toHaveLength(1);
    expect(state.calls.insert[0]?.options).toEqual({ retry: false });
  });

  it.each([undefined, null, {}, { id: "  " }, { id: 7 }, { id: "edit-7", expiryTimeSeconds: "x" }])(
    "rejects malformed edits.insert response %j",
    async (response) => {
      const { client } = fakePublisher({ insert: [response] });
      await expect(createEdit(client, { packageName: "com.example.app" })).rejects.toMatchObject({
        name: "PublisherError",
        code: "INVALID_RESPONSE",
      });
    },
  );

  it("gets an edit using packageName/editId and the PlayOps retry boundary", async () => {
    const temporary = Object.assign(new Error("PRIVATE-429-DETAIL"), { status: 429 });
    const { client, state } = fakePublisher({
      getEdit: [temporary, { id: "edit-7", expiryTimeSeconds: "1900000000" }],
    });
    const sleeps: number[] = [];

    const edit = await getEdit(
      client,
      { packageName: "com.example.app", editId: "edit-7" },
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    );

    expect(state.calls.getEdit).toEqual([
      {
        params: { packageName: "com.example.app", editId: "edit-7" },
        options: { retry: false },
      },
      {
        params: { packageName: "com.example.app", editId: "edit-7" },
        options: { retry: false },
      },
    ]);
    expect(sleeps).toHaveLength(1);
    expect(edit).toEqual({ id: "edit-7", expiryTimeSeconds: "1900000000" });
  });

  it("rejects getEdit response whose id does not match the requested edit", async () => {
    const { client, state } = fakePublisher({ getEdit: [{ id: "another-edit" }] });

    await expect(
      getEdit(client, { packageName: "com.example.app", editId: "edit-7" }),
    ).rejects.toMatchObject({ name: "PublisherError", code: "INVALID_RESPONSE" });
    expect(state.calls.getEdit).toHaveLength(1);
  });

  it("lists tracks inside the edit and preserves the generated result order", async () => {
    const tracks = [
      { track: "internal", releases: [] },
      { track: "production", releases: [{ status: "completed" }] },
    ];
    const { client, state } = fakePublisher({ listTracks: [{ tracks }] });

    const result = await listTracks(client, {
      packageName: "com.example.app",
      editId: "edit-7",
    });

    expect(state.calls.listTracks).toEqual([
      {
        params: { packageName: "com.example.app", editId: "edit-7" },
        options: { retry: false },
      },
    ]);
    expect(result.tracks).toEqual(tracks);
  });

  it("uses PlayOps read retry for edits.tracks.list and disables generated retry each time", async () => {
    const temporary = Object.assign(new Error("PRIVATE-503-DETAIL"), { response: { status: 503 } });
    const { client, state } = fakePublisher({ listTracks: [temporary, { tracks: [] }] });

    const result = await listTracks(
      client,
      { packageName: "com.example.app", editId: "edit-7" },
      { sleep: async () => undefined, random: () => 0 },
    );

    expect(result.tracks).toEqual([]);
    expect(state.calls.listTracks).toHaveLength(2);
    expect(state.calls.listTracks.map((call) => call.options)).toEqual([
      { retry: false },
      { retry: false },
    ]);
  });

  it.each([undefined, null, { tracks: "not-an-array" }, { tracks: [null] }])(
    "rejects malformed edits.tracks.list response %j",
    async (response) => {
      const { client } = fakePublisher({ listTracks: [response] });
      await expect(
        listTracks(client, { packageName: "com.example.app", editId: "edit-7" }),
      ).rejects.toMatchObject({ name: "PublisherError", code: "INVALID_RESPONSE" });
    },
  );

  it("gets a track with the exact track name and generated retry disabled", async () => {
    const { client, state } = fakePublisher({
      getTrack: [{ track: "wear:production", releases: [] }],
    });

    const track = await getTrack(client, {
      packageName: "com.example.app",
      editId: "edit-7",
      track: "wear:production",
    });

    expect(state.calls.getTrack).toEqual([
      {
        params: {
          packageName: "com.example.app",
          editId: "edit-7",
          track: "wear:production",
        },
        options: { retry: false },
      },
    ]);
    expect(track).toEqual({ track: "wear:production", releases: [] });
  });

  it.each([undefined, null, {}, { track: "internal" }])(
    "rejects malformed or mismatched edits.tracks.get response %j",
    async (response) => {
      const { client } = fakePublisher({ getTrack: [response] });
      await expect(
        getTrack(client, {
          packageName: "com.example.app",
          editId: "edit-7",
          track: "production",
        }),
      ).rejects.toMatchObject({ name: "PublisherError", code: "INVALID_RESPONSE" });
    },
  );

  it("rejects invalid wrapper arguments before any API operation", async () => {
    const { client, state } = fakePublisher();

    await expect(createEdit(client, { packageName: "  " })).rejects.toBeInstanceOf(PublisherError);
    await expect(
      getEdit(client, { packageName: "com.example.app", editId: " " }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      listTracks(client, { packageName: "com.example.app", editId: " " }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      getTrack(client, {
        packageName: "com.example.app",
        editId: "edit-7",
        track: " ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(state.calls.insert).toHaveLength(0);
    expect(state.calls.getEdit).toHaveLength(0);
    expect(state.calls.listTracks).toHaveLength(0);
    expect(state.calls.getTrack).toHaveLength(0);
  });
});
