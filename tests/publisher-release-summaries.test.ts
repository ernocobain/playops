import { describe, expect, it } from "vitest";
import {
  listReleaseSummaries,
  type AndroidPublisherClient,
  type ApplicationsResourceLike,
  type EditsResourceLike,
  type ReviewsResourceLike,
} from "../src/googleplay/publisher/index.js";

function fakeClient(options: { readonly data?: unknown; readonly failure?: unknown } = {}) {
  const calls: { params: unknown; options: unknown }[] = [];
  const applications: ApplicationsResourceLike = {
    tracks: {
      releases: {
        list: async (params, requestOptions) => {
          calls.push({ params, options: requestOptions });
          if (options.failure !== undefined) throw options.failure;
          return { data: options.data ?? { releases: [] } };
        },
      },
    },
  };
  const edits = {
    insert: async () => ({ data: {} }),
    get: async () => ({ data: {} }),
    tracks: {
      list: async () => ({ data: {} }),
      get: async () => ({ data: {} }),
      update: async () => ({ data: {} }),
    },
    bundles: { list: async () => ({ data: {} }), upload: async () => ({ data: {} }) },
  } as unknown as EditsResourceLike;
  return {
    client: { version: "v3", reviews: {} as ReviewsResourceLike, edits, applications },
    calls,
  } as const;
}

describe("applications.tracks.releases.list Publisher wrapper", () => {
  it("forwards exact parent with retry:false and normalizes lossless artifact version codes", async () => {
    const fake = fakeClient({
      data: {
        releases: [
          {
            releaseName: "Candidate 101",
            track: "production",
            releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
            activeArtifacts: [{ versionCode: 101 }, { versionCode: 102 }],
          },
        ],
      },
    });
    await expect(
      listReleaseSummaries(fake.client, {
        parent: "applications/com.example.app/tracks/production",
      }),
    ).resolves.toEqual({
      releases: [
        {
          releaseName: "Candidate 101",
          track: "production",
          releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
          versionCodes: ["101", "102"],
        },
      ],
    });
    expect(fake.calls).toEqual([
      {
        params: { parent: "applications/com.example.app/tracks/production" },
        options: { retry: false },
      },
    ]);
  });

  it("returns an empty release list without inventing pagination", async () => {
    const fake = fakeClient({ data: {} });
    await expect(
      listReleaseSummaries(fake.client, {
        parent: "applications/com.example.app/tracks/wear:production",
      }),
    ).resolves.toEqual({ releases: [] });
  });

  it("rejects malformed summary and unsafe version codes", async () => {
    await expect(
      listReleaseSummaries(
        fakeClient({
          data: {
            releases: [
              {
                releaseName: "Candidate",
                track: "production",
                releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
                activeArtifacts: [{ versionCode: Number.MAX_SAFE_INTEGER + 1 }],
              },
            ],
          },
        }).client,
        { parent: "applications/com.example.app/tracks/production" },
      ),
    ).rejects.toMatchObject({ name: "PublisherError", code: "INVALID_RESPONSE" });
  });

  it("uses bounded read retry while keeping generated retry disabled", async () => {
    let attempts = 0;
    const fake = fakeClient({ failure: Object.assign(new Error("PRIVATE-503"), { status: 503 }) });
    const actionClient = {
      ...fake.client,
      applications: {
        tracks: {
          releases: {
            list: async (params: unknown, options: unknown) => {
              attempts += 1;
              if (attempts < 3) throw Object.assign(new Error("PRIVATE-503"), { status: 503 });
              expect(params).toEqual({ parent: "applications/com.example.app/tracks/production" });
              expect(options).toEqual({ retry: false });
              return { data: { releases: [] } };
            },
          },
        },
      },
    } as AndroidPublisherClient;
    await expect(
      listReleaseSummaries(
        actionClient,
        {
          parent: "applications/com.example.app/tracks/production",
        },
        { sleep: async () => undefined, random: () => 0 },
      ),
    ).resolves.toEqual({ releases: [] });
    expect(attempts).toBe(3);
  });
});
