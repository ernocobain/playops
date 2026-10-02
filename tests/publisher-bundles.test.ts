import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAuthClient } from "../src/googleplay/auth/index.js";
import {
  createAndroidPublisherClient,
  listBundles,
  PublisherError,
  uploadBundle,
  type AndroidPublisherClient,
  type EditsResourceLike,
} from "../src/googleplay/publisher/index.js";

const packageName = "com.example.bundle";
const editId = "edit-bundle-1";
const sha256 = "a".repeat(64);
const sha1 = "b".repeat(40);
const ambiguousUploadFailures: readonly { readonly label: string; readonly failure: Error }[] = [
  { label: "429", failure: Object.assign(new Error("FAKE-429"), { status: 429 }) },
  { label: "500", failure: Object.assign(new Error("FAKE-500"), { status: 500 }) },
  { label: "502", failure: Object.assign(new Error("FAKE-502"), { status: 502 }) },
  { label: "503", failure: Object.assign(new Error("FAKE-503"), { status: 503 }) },
  { label: "504", failure: Object.assign(new Error("FAKE-504"), { status: 504 }) },
  { label: "timeout", failure: Object.assign(new Error("FAKE-TIMEOUT"), { code: "ETIMEDOUT" }) },
  {
    label: "network reset",
    failure: Object.assign(new Error("FAKE-RESET"), { code: "ECONNRESET" }),
  },
];

interface RecordedCall {
  readonly params: unknown;
  readonly options: unknown;
}

function take(queue: unknown[]): { data: unknown } {
  const result = queue.shift();
  if (result instanceof Error) throw result;
  return { data: result };
}

function fakeClient(
  options: {
    readonly uploads?: unknown[];
    readonly lists?: unknown[];
  } = {},
): {
  readonly client: AndroidPublisherClient;
  readonly calls: { readonly upload: RecordedCall[]; readonly list: RecordedCall[] };
} {
  const calls = { upload: [] as RecordedCall[], list: [] as RecordedCall[] };
  const uploads = [...(options.uploads ?? [{ versionCode: 42, sha256, sha1 }])];
  const lists = [...(options.lists ?? [{ bundles: [{ versionCode: 42, sha256, sha1 }] }])];
  const bundles = {
    upload: vi.fn(async (params: unknown, requestOptions: unknown) => {
      calls.upload.push({ params, options: requestOptions });
      return take(uploads);
    }),
    list: vi.fn(async (params: unknown, requestOptions: unknown) => {
      calls.list.push({ params, options: requestOptions });
      return take(lists);
    }),
  };
  const edits = {
    insert: vi.fn(),
    get: vi.fn(),
    tracks: { list: vi.fn(), get: vi.fn() },
    bundles,
  } as unknown as EditsResourceLike;
  return {
    client: {
      version: "v3",
      reviews: { list: vi.fn(), get: vi.fn(), reply: vi.fn() },
      edits,
    },
    calls,
  };
}

const bundleBytes = (): Readable => Readable.from(Buffer.from("fake-aab-bytes"));

describe("Android Publisher bundle upload wrapper", () => {
  it("maps the media stream into the installed upload contract without the deprecated acknowledgement", async () => {
    const { client, calls } = fakeClient();
    const body = bundleBytes();

    const bundle = await uploadBundle(client, { packageName, editId, body });

    expect(calls.upload).toHaveLength(1);
    expect(calls.upload[0]).toEqual({
      params: {
        packageName,
        editId,
        media: { mimeType: "application/octet-stream", body },
      },
      options: { retry: false, timeout: 120_000 },
    });
    expect(calls.upload[0]?.params).not.toHaveProperty("ackBundleInstallationWarning");
    expect(bundle).toEqual({ versionCode: "42", sha256, sha1 });
  });

  it("accepts the current Google Play maximum and returns canonical decimal versionCode", async () => {
    const { client } = fakeClient({ uploads: [{ versionCode: 2_100_000_000, sha256 }] });

    await expect(
      uploadBundle(client, { packageName, editId, body: bundleBytes() }),
    ).resolves.toEqual({ versionCode: "2100000000", sha256 });
  });

  it.each([
    [{ versionCode: 42.5, sha256 }],
    [{ versionCode: Number.MAX_SAFE_INTEGER + 1, sha256 }],
    [{ versionCode: 2_100_000_001, sha256 }],
    [{ versionCode: 0, sha256 }],
    [{ versionCode: 42, sha256: "bad" }],
    [{ versionCode: 42, sha256: "g".repeat(64) }],
    [{ versionCode: 42, sha256, sha1: "bad" }],
  ])("rejects malformed upload bundle response %j", async (response) => {
    const { client } = fakeClient({ uploads: [response] });

    await expect(
      uploadBundle(client, { packageName, editId, body: bundleBytes() }),
    ).rejects.toMatchObject({
      name: "PublisherError",
      code: "INVALID_RESPONSE",
    });
  });

  it.each(ambiguousUploadFailures)(
    "makes one upload attempt for ambiguous $label failures",
    async ({ failure }) => {
      const { client, calls } = fakeClient({ uploads: [failure] });

      await expect(
        uploadBundle(client, { packageName, editId, body: bundleBytes() }),
      ).rejects.toMatchObject({
        name: "PublisherError",
        code: "API_REQUEST_FAILED",
        cause: failure,
      });
      expect(calls.upload).toHaveLength(1);
      expect(calls.upload[0]?.options).toEqual({ retry: false, timeout: 120_000 });
    },
  );
});

describe("Android Publisher bundle list wrapper", () => {
  it("forwards the package and exact edit, returning deterministic normalized bundle values", async () => {
    const { client, calls } = fakeClient({
      lists: [
        {
          bundles: [
            { versionCode: 2, sha256: "C".repeat(64), sha1: "D".repeat(40), extra: "drop" },
            { versionCode: 42, sha256, sha1 },
          ],
        },
      ],
    });

    const bundles = await listBundles(client, { packageName, editId });

    expect(calls.list).toEqual([{ params: { packageName, editId }, options: { retry: false } }]);
    expect(bundles).toEqual([
      { versionCode: "2", sha256: "c".repeat(64), sha1: "d".repeat(40) },
      { versionCode: "42", sha256, sha1 },
    ]);
  });

  it("normalizes an empty or omitted bundle collection to an empty list", async () => {
    for (const response of [{ bundles: [] }, {}]) {
      const { client } = fakeClient({ lists: [response] });
      await expect(listBundles(client, { packageName, editId })).resolves.toEqual([]);
    }
  });

  it("uses only the PlayOps read retry budget and disables generated retries per request", async () => {
    const unavailable = Object.assign(new Error("FAKE-503"), { status: 503 });
    const { client, calls } = fakeClient({
      lists: [unavailable, { bundles: [{ versionCode: 42, sha256 }] }],
    });
    const sleeps: number[] = [];

    const result = await listBundles(
      client,
      { packageName, editId },
      { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0 },
    );

    expect(result).toEqual([{ versionCode: "42", sha256 }]);
    expect(calls.list).toHaveLength(2);
    expect(calls.list.map((call) => call.options)).toEqual([{ retry: false }, { retry: false }]);
    expect(sleeps).toHaveLength(1);
  });

  it("rejects malformed bundle-list payloads", async () => {
    for (const response of [null, { bundles: "not-an-array" }, { bundles: [null] }]) {
      const { client } = fakeClient({ lists: [response] });
      await expect(listBundles(client, { packageName, editId })).rejects.toMatchObject({
        name: "PublisherError",
        code: "INVALID_RESPONSE",
      });
    }
  });

  it("rejects blank package and edit identifiers before the API call", async () => {
    const { client, calls } = fakeClient();

    await expect(listBundles(client, { packageName: " ", editId })).rejects.toBeInstanceOf(
      PublisherError,
    );
    await expect(listBundles(client, { packageName, editId: " " })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(calls.list).toHaveLength(0);
  });
});

describe("installed generated Android Publisher bundle contract", () => {
  it("maps one streamed media upload to the generated POST endpoint with explicit options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network forbidden in test"))),
    );
    const requests: Record<string, unknown>[] = [];
    const auth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TEST-TOKEN" }),
      request: async (options: Record<string, unknown>) => {
        requests.push(options);
        return { data: { versionCode: 73, sha256 } };
      },
    } as unknown as GoogleAuthClient;
    const client = createAndroidPublisherClient(auth);
    const body = bundleBytes();

    await expect(
      uploadBundle(client, {
        packageName,
        editId,
        body,
      }),
    ).resolves.toEqual({ versionCode: "73", sha256 });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toMatchObject({
      method: "POST",
      retry: false,
      timeout: 120_000,
    });
    expect(String(request?.url)).toContain(
      `/upload/androidpublisher/v3/applications/${packageName}/edits/${editId}/bundles`,
    );
    expect(request?.data).toBe(body);
    expect(request?.params).toMatchObject({ uploadType: "media" });
    expect(request?.params).not.toHaveProperty("ackBundleInstallationWarning");
    const headers = request?.headers as { get?: (name: string) => string | null } | undefined;
    expect(headers?.get?.("content-type")).toBe("application/octet-stream");
    body.destroy();
  });

  it("does not retry a real generated-client upload after an ambiguous 429", async () => {
    const requests: Record<string, unknown>[] = [];
    const failure = Object.assign(new Error("FAKE-429-PRIVATE"), { status: 429 });
    const auth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TEST-TOKEN" }),
      request: async (options: Record<string, unknown>) => {
        requests.push(options);
        throw failure;
      },
    } as unknown as GoogleAuthClient;
    const client = createAndroidPublisherClient(auth);
    const body = bundleBytes();

    await expect(uploadBundle(client, { packageName, editId, body })).rejects.toMatchObject({
      code: "API_REQUEST_FAILED",
      cause: failure,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", retry: false, timeout: 120_000 });
    body.destroy();
  });
});
