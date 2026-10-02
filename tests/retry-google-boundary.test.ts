import { describe, expect, it } from "vitest";
import {
  createAndroidPublisherClient,
  createEdit,
  getEdit,
  getTrack,
  listReviews,
  listTracks,
} from "../src/googleplay/publisher/index.js";
import { createPlayReportingClient, queryAnrRate } from "../src/googleplay/reporting/index.js";

interface RequestOptions {
  retry?: boolean;
  method?: string;
  url?: string;
}

describe("generated Google request boundary", () => {
  it("never stacks generated-client retries on top of the three-attempt PlayOps budget", async () => {
    const requests: RequestOptions[] = [];
    const failure = Object.assign(new Error("temporary"), { status: 503 });
    const auth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TEST-TOKEN" }),
      request: (options: RequestOptions) => {
        requests.push({ retry: options.retry, method: options.method });
        return Promise.reject(failure);
      },
    };
    await expect(
      listReviews(
        createAndroidPublisherClient(auth),
        { packageName: "com.example.app" },
        { sleep: () => Promise.resolve(), random: () => 1 },
      ),
    ).rejects.toMatchObject({ code: "API_REQUEST_FAILED", cause: failure });
    expect(requests).toEqual(Array.from({ length: 3 }, () => ({ retry: false, method: "GET" })));
  });

  it("disables Gaxios retry for a real generated Publisher GET", async () => {
    const requests: RequestOptions[] = [];
    const auth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TEST-TOKEN" }),
      request: (options: RequestOptions) => {
        requests.push({ retry: options.retry, method: options.method });
        return requests.length === 1
          ? Promise.reject(Object.assign(new Error("transient"), { status: 429 }))
          : Promise.resolve({ data: { reviews: [{ reviewId: "r" }] }, headers: new Headers() });
      },
    };
    const result = await listReviews(
      createAndroidPublisherClient(auth),
      { packageName: "com.example.app" },
      { sleep: () => Promise.resolve(), random: () => 1 },
    );
    expect(result).toEqual({ reviews: [{ reviewId: "r" }] });
    expect(requests).toEqual([
      { retry: false, method: "GET" },
      { retry: false, method: "GET" },
    ]);
  });

  it("disables Gaxios retry for a real generated Reporting read-only POST", async () => {
    const requests: RequestOptions[] = [];
    const auth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TEST-TOKEN" }),
      request: (options: RequestOptions) => {
        requests.push({ retry: options.retry, method: options.method });
        return requests.length === 1
          ? Promise.reject(Object.assign(new Error("transient"), { status: 503 }))
          : Promise.resolve({ data: { rows: [] }, headers: new Headers() });
      },
    };
    const result = await queryAnrRate(
      createPlayReportingClient(auth),
      { packageName: "com.example.app" },
      { sleep: () => Promise.resolve(), random: () => 1 },
    );
    expect(result).toEqual({ rows: [] });
    expect(requests).toEqual([
      { retry: false, method: "POST" },
      { retry: false, method: "POST" },
    ]);
  });

  it("keeps generated Edits insert to one POST attempt with retry disabled", async () => {
    const requests: RequestOptions[] = [];
    const auth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TEST-TOKEN" }),
      request: (options: RequestOptions) => {
        requests.push({ retry: options.retry, method: options.method, url: options.url });
        return Promise.resolve({ data: { id: "edit-new", expiryTimeSeconds: "1900000000" } });
      },
    };

    const edit = await createEdit(createAndroidPublisherClient(auth), {
      packageName: "com.example.app",
    });

    expect(edit).toEqual({ id: "edit-new", expiryTimeSeconds: "1900000000" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ retry: false, method: "POST" });
    expect(requests[0]?.url).toContain("/applications/com.example.app/edits");
  });

  it("uses only PlayOps retries for generated edits.get and tracks list/get GETs", async () => {
    const requests: RequestOptions[] = [];
    const auth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TEST-TOKEN" }),
      request: (options: RequestOptions) => {
        requests.push({ retry: options.retry, method: options.method, url: options.url });
        if (requests.length === 1 || requests.length === 3 || requests.length === 5) {
          return Promise.reject(Object.assign(new Error("transient"), { status: 429 }));
        }
        if (options.url?.endsWith("/edits/edit-read")) {
          return Promise.resolve({ data: { id: "edit-read" } });
        }
        if (options.url?.endsWith("/edits/edit-read/tracks")) {
          return Promise.resolve({ data: { tracks: [{ track: "internal" }] } });
        }
        if (options.url?.includes("/edits/edit-read/tracks/")) {
          return Promise.resolve({ data: { track: "wear:production", releases: [] } });
        }
        return Promise.reject(new Error("unexpected fake request"));
      },
    };
    const client = createAndroidPublisherClient(auth);
    const retryOptions = { sleep: () => Promise.resolve(), random: () => 1 };

    await expect(
      getEdit(client, { packageName: "com.example.app", editId: "edit-read" }, retryOptions),
    ).resolves.toEqual({ id: "edit-read" });
    await expect(
      listTracks(client, { packageName: "com.example.app", editId: "edit-read" }, retryOptions),
    ).resolves.toEqual({ tracks: [{ track: "internal" }] });
    await expect(
      getTrack(
        client,
        { packageName: "com.example.app", editId: "edit-read", track: "wear:production" },
        retryOptions,
      ),
    ).resolves.toEqual({ track: "wear:production", releases: [] });

    expect(requests).toHaveLength(6);
    expect(requests.map(({ retry, method }) => ({ retry, method }))).toEqual(
      Array.from({ length: 6 }, () => ({ retry: false, method: "GET" })),
    );
    expect(requests[0]?.url).toContain("/edits/edit-read");
    expect(requests[2]?.url).toContain("/edits/edit-read/tracks");
    expect(requests[5]?.url).toContain("/edits/edit-read/tracks/");
  });
});
