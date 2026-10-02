/**
 * Phase 1.3 — Play Developer Reporting client wrapper unit tests.
 *
 * No network, no real credentials. Only the Google client boundary
 * (ReportingClientFactory / VitalsResourceLike) is faked; PlayOps validation
 * and normalization are exercised for real.
 */
import { describe, expect, it } from "vitest";
import type { GoogleAuthClient } from "../src/googleplay/auth/index.js";
import {
  createPlayReportingClient,
  getAnrRateMetricSet,
  getCrashRateMetricSet,
  getExcessiveWakeupRateMetricSet,
  queryAnrRate,
  queryCrashRate,
  queryExcessiveWakeupRate,
  type MetricsRow,
  type PlayReportingClient,
  type ReportingClientFactory,
  type ReportingError,
  type VitalsResourceLike,
} from "../src/googleplay/reporting/index.js";

const FAKE_TOKEN = "ya29.fake-token-1.3";
const FAKE_KEY = "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-1.3\n-----END PRIVATE KEY-----\n";

const fakeAuth: GoogleAuthClient = {
  getAccessToken: () => Promise.resolve({ token: FAKE_TOKEN }),
};

interface FakeVitals {
  calls: { kind: string; params: Record<string, unknown> }[];
  getData: unknown;
  queryData: unknown;
  failOn?: string;
  failure?: unknown;
}

function clientWith(vitals: Partial<FakeVitals> = {}): {
  client: PlayReportingClient;
  calls: FakeVitals["calls"];
} {
  const state: FakeVitals = {
    calls: [],
    getData: { name: "apps/x/anrRateMetricSet", freshnessInfo: { freshnesses: [] } },
    queryData: { rows: [], nextPageToken: null },
    ...vitals,
  };

  function makeVerb(kind: string, data: unknown) {
    return (params: Record<string, unknown>) => {
      state.calls.push({ kind, params });
      if (state.failOn === kind) return Promise.reject(state.failure);
      return Promise.resolve({ data });
    };
  }

  const resource: VitalsResourceLike = {
    anrrate: {
      get: makeVerb("anr.get", state.getData) as VitalsResourceLike["anrrate"]["get"],
      query: makeVerb("anr.query", state.queryData) as VitalsResourceLike["anrrate"]["query"],
    },
    crashrate: {
      get: makeVerb("crash.get", state.getData) as VitalsResourceLike["crashrate"]["get"],
      query: makeVerb("crash.query", state.queryData) as VitalsResourceLike["crashrate"]["query"],
    },
    excessivewakeuprate: {
      get: makeVerb(
        "wakeup.get",
        state.getData,
      ) as VitalsResourceLike["excessivewakeuprate"]["get"],
      query: makeVerb(
        "wakeup.query",
        state.queryData,
      ) as VitalsResourceLike["excessivewakeuprate"]["query"],
    },
  };
  return { client: { version: "v1beta1", vitals: resource }, calls: state.calls };
}

const PKG = "com.example.app";
const TIMELINE = {
  aggregationPeriod: "DAILY",
  startTime: { year: 2026, month: 9, day: 1 },
  endTime: { year: 2026, month: 9, day: 24 },
};

describe("createPlayReportingClient", () => {
  it("passes the Phase 1.1 auth client into a v1beta1 reporting client", () => {
    const captured: { value?: { version: string; auth: unknown; retry: boolean } } = {};
    const factory: ReportingClientFactory = (options) => {
      captured.value = options;
      return clientWith().client;
    };

    const client = createPlayReportingClient(fakeAuth, factory);

    expect(captured.value?.version).toBe("v1beta1");
    expect(captured.value?.auth).toBe(fakeAuth);
    expect(captured.value?.retry).toBe(false);
    expect(client.version).toBe("v1beta1");
  });
});

describe("metric set get", () => {
  it("retries a transient 500 on ANR get and returns the original shape", async () => {
    const { client } = clientWith();
    let calls = 0;
    const retrySettings: unknown[] = [];
    client.vitals.anrrate.get = (_params, options) => {
      retrySettings.push(options);
      return ++calls === 1
        ? Promise.reject(Object.assign(new Error("temporary"), { status: 500 }))
        : Promise.resolve({ data: { name: `apps/${PKG}/anrRateMetricSet` } });
    };
    const result = await getAnrRateMetricSet(client, PKG, { sleep: () => Promise.resolve() });
    expect(calls).toBe(2);
    expect(retrySettings).toEqual([{ retry: false }, { retry: false }]);
    expect(result).toEqual({ name: `apps/${PKG}/anrRateMetricSet` });
  });

  it("builds the ANR resource name and returns metric-set data", async () => {
    const { client, calls } = clientWith();
    const result = await getAnrRateMetricSet(client, PKG);

    expect(calls).toEqual([{ kind: "anr.get", params: { name: `apps/${PKG}/anrRateMetricSet` } }]);
    expect(result.name).toBe("apps/x/anrRateMetricSet");
    expect(result.freshnessInfo).toEqual({ freshnesses: [] });
  });

  it("builds the crash resource name and returns metric-set data", async () => {
    const { client, calls } = clientWith({
      getData: { name: `apps/${PKG}/crashRateMetricSet`, freshnessInfo: { freshnesses: [] } },
    });
    const result = await getCrashRateMetricSet(client, PKG);

    expect(calls).toEqual([
      { kind: "crash.get", params: { name: `apps/${PKG}/crashRateMetricSet` } },
    ]);
    expect(result.name).toBe(`apps/${PKG}/crashRateMetricSet`);
  });

  it("retries a transient 503 on crash metric-set get", async () => {
    const { client } = clientWith();
    let calls = 0;
    const retrySettings: unknown[] = [];
    client.vitals.crashrate.get = (_params, options) => {
      retrySettings.push(options);
      return ++calls === 1
        ? Promise.reject({ response: { status: 503 } })
        : Promise.resolve({ data: { name: `apps/${PKG}/crashRateMetricSet` } });
    };
    expect(await getCrashRateMetricSet(client, PKG, { sleep: () => Promise.resolve() })).toEqual({
      name: `apps/${PKG}/crashRateMetricSet`,
    });
    expect(calls).toBe(2);
    expect(retrySettings).toEqual([{ retry: false }, { retry: false }]);
  });

  it("rejects blank packageName on get", async () => {
    const { client } = clientWith();
    await expect(getAnrRateMetricSet(client, "  ")).rejects.toMatchObject({
      name: "ReportingError",
      code: "INVALID_ARGUMENT",
    });
    await expect(getCrashRateMetricSet(client, "")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("wraps API failure safely on get, without secrets", async () => {
    const failure = Object.assign(new Error("quota exceeded"), { code: 429 });
    const { client } = clientWith({ failOn: "anr.get", failure });

    try {
      await getAnrRateMetricSet(client, PKG, { sleep: () => Promise.resolve() });
      expect.unreachable();
    } catch (error) {
      const repError = error as ReportingError;
      expect(repError.code).toBe("API_REQUEST_FAILED");
      expect(repError.message).toContain("vitals.anrrate.get");
      expect(repError.message).toContain(`apps/${PKG}/anrRateMetricSet`);
      expect(repError.message).toContain("429");
      expect(repError.message).not.toContain(FAKE_TOKEN);
      expect(repError.message).not.toContain(FAKE_KEY);
      expect(repError.message).not.toContain("Authorization");
      expect(repError.cause).toBe(failure);
    }
  });
});

describe("queryAnrRate", () => {
  it("retries a transient 429 on ANR query (read-only POST) with exact call count", async () => {
    const { client } = clientWith();
    let calls = 0;
    const retrySettings: unknown[] = [];
    client.vitals.anrrate.query = (_params, options) => {
      retrySettings.push(options);
      return ++calls === 1
        ? Promise.reject(Object.assign(new Error("throttled"), { code: 429 }))
        : Promise.resolve({
            data: { rows: [{ metrics: [{ metric: "anrRate" }] }], nextPageToken: "N2" },
          });
    };
    const result = await queryAnrRate(
      client,
      { packageName: PKG },
      { sleep: () => Promise.resolve() },
    );
    expect(calls).toBe(2);
    expect(retrySettings).toEqual([{ retry: false }, { retry: false }]);
    expect(result).toEqual({ rows: [{ metrics: [{ metric: "anrRate" }] }], nextPageToken: "N2" });
  });

  it("builds the resource name and propagates all supported fields", async () => {
    const { client, calls } = clientWith({
      queryData: { rows: [{ startTime: { year: 2026, month: 9, day: 1 } }], nextPageToken: "N2" },
    });

    const result = await queryAnrRate(client, {
      packageName: PKG,
      timelineSpec: TIMELINE,
      dimensions: ["versionCode", "countryCode"],
      metrics: ["anrRate", "distinctUsers"],
      filter: 'countryCode = "ID"',
      pageSize: 500,
      pageToken: "PAGE1",
      userCohort: "OS_PUBLIC",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("anr.query");
    const params = calls[0]?.params as {
      name: string;
      requestBody: Record<string, unknown>;
    };
    expect(params.name).toBe(`apps/${PKG}/anrRateMetricSet`);
    expect(params.requestBody).toEqual({
      timelineSpec: TIMELINE,
      dimensions: ["versionCode", "countryCode"],
      metrics: ["anrRate", "distinctUsers"],
      filter: 'countryCode = "ID"',
      pageSize: 500,
      pageToken: "PAGE1",
      userCohort: "OS_PUBLIC",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.nextPageToken).toBe("N2");
  });

  it("normalizes absent rows to [] and omits empty nextPageToken", async () => {
    const { client } = clientWith({ queryData: { nextPageToken: "" } });
    const result = await queryAnrRate(client, { packageName: PKG });
    expect(result.rows).toEqual([]);
    expect(result.nextPageToken).toBeUndefined();
  });

  it("preserves row order", async () => {
    const rows: MetricsRow[] = [
      { dimensions: [{ dimension: "countryCode", stringValue: "ID" }] },
      { dimensions: [{ dimension: "countryCode", stringValue: "US" }] },
    ];
    const { client } = clientWith({ queryData: { rows } });
    const result = await queryAnrRate(client, { packageName: PKG });
    expect(result.rows.map((r) => r.dimensions?.[0]?.stringValue)).toEqual(["ID", "US"]);
  });
});

describe("queryCrashRate", () => {
  it("retries a transient 502 on crash query", async () => {
    const { client } = clientWith();
    let calls = 0;
    const retrySettings: unknown[] = [];
    client.vitals.crashrate.query = (_params, options) => {
      retrySettings.push(options);
      return ++calls === 1
        ? Promise.reject({ response: { status: 502 } })
        : Promise.resolve({ data: { rows: [] } });
    };
    expect(
      await queryCrashRate(client, { packageName: PKG }, { sleep: () => Promise.resolve() }),
    ).toEqual({ rows: [] });
    expect(calls).toBe(2);
    expect(retrySettings).toEqual([{ retry: false }, { retry: false }]);
  });

  it("builds the crash resource name, propagates fields, normalizes result", async () => {
    const { client, calls } = clientWith({
      queryData: { rows: [{ metrics: [{ metric: "crashRate" }] }], nextPageToken: "C2" },
    });

    const result = await queryCrashRate(client, {
      packageName: PKG,
      metrics: ["crashRate"],
      pageSize: 10,
    });

    const params = calls[0]?.params as { name: string; requestBody: Record<string, unknown> };
    expect(calls[0]?.kind).toBe("crash.query");
    expect(params.name).toBe(`apps/${PKG}/crashRateMetricSet`);
    expect(params.requestBody).toEqual({ metrics: ["crashRate"], pageSize: 10 });
    expect(result.rows).toHaveLength(1);
    expect(result.nextPageToken).toBe("C2");
  });
});

describe("query validation", () => {
  it("rejects blank packageName", async () => {
    const { client } = clientWith();
    await expect(queryAnrRate(client, { packageName: "" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(queryCrashRate(client, { packageName: " " })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects invalid pageSize values", async () => {
    const { client } = clientWith();
    for (const bad of [0, -5, 3.7, 100_001, Number.NaN]) {
      await expect(queryAnrRate(client, { packageName: PKG, pageSize: bad })).rejects.toMatchObject(
        { code: "INVALID_ARGUMENT" },
      );
    }
  });

  it("rejects blank pageToken, dimensions entries, metrics entries, filter", async () => {
    const { client } = clientWith();
    await expect(queryAnrRate(client, { packageName: PKG, pageToken: " " })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      queryAnrRate(client, { packageName: PKG, dimensions: ["ok", ""] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(queryAnrRate(client, { packageName: PKG, metrics: ["  "] })).rejects.toMatchObject(
      { code: "INVALID_ARGUMENT" },
    );
    await expect(queryAnrRate(client, { packageName: PKG, filter: "" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("wraps query API failure safely, without secrets", async () => {
    const failure = Object.assign(new Error("invalid argument"), { code: 400 });
    const { client } = clientWith({ failOn: "crash.query", failure });

    try {
      await queryCrashRate(client, { packageName: PKG });
      expect.unreachable();
    } catch (error) {
      const repError = error as ReportingError;
      expect(repError.code).toBe("API_REQUEST_FAILED");
      expect(repError.message).toContain("vitals.crashrate.query");
      expect(repError.message).toContain("400");
      expect(repError.message).not.toContain(FAKE_TOKEN);
      expect(repError.message).not.toContain(FAKE_KEY);
      expect(JSON.stringify(repError)).not.toContain(FAKE_TOKEN);
    }
  });

  it("exhausts with a safe domain message and the original cause still available", async () => {
    const fakeSecret = "FAKE-BEARER-SHOULD-NOT-APPEAR";
    const failure = Object.assign(new Error(`Authorization: ${fakeSecret}`), {
      code: 503,
      config: { headers: { Authorization: fakeSecret } },
    });
    const { client, calls } = clientWith({ failOn: "crash.query", failure });
    try {
      await queryCrashRate(
        client,
        { packageName: PKG },
        { sleep: () => Promise.resolve(), random: () => 1 },
      );
      expect.unreachable();
    } catch (error) {
      const wrapped = error as ReportingError;
      expect(wrapped.cause).toBe(failure);
      expect(wrapped.code).toBe("API_REQUEST_FAILED");
      expect(wrapped.message).toContain("503");
      expect(wrapped.message).not.toContain(fakeSecret);
      expect(JSON.stringify(wrapped)).not.toContain(fakeSecret);
    }
    expect(calls).toHaveLength(3);
  });

  it("throws INVALID_RESPONSE when rows is not an array", async () => {
    const { client } = clientWith({ queryData: { rows: "nope" } });
    await expect(queryAnrRate(client, { packageName: PKG })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

describe("Phase 5.1 excessive wakeup rate metric set", () => {
  it("builds the excessiveWakeupRateMetricSet name and returns metric-set data", async () => {
    const name = `apps/${PKG}/excessiveWakeupRateMetricSet`;
    const { client, calls } = clientWith({
      getData: { name, freshnessInfo: { freshnesses: [] } },
    });

    const result = await getExcessiveWakeupRateMetricSet(client, PKG);

    expect(calls).toEqual([{ kind: "wakeup.get", params: { name } }]);
    expect(result.name).toBe(name);
    expect(result.freshnessInfo).toEqual({ freshnesses: [] });
  });

  it("queries the exact resource with the exact request and keeps one call per page", async () => {
    const name = `apps/${PKG}/excessiveWakeupRateMetricSet`;
    const { client, calls } = clientWith({
      queryData: { rows: [{ metrics: [{ metric: "excessiveWakeupRate" }] }], nextPageToken: "W2" },
    });

    const result = await queryExcessiveWakeupRate(client, {
      packageName: PKG,
      timelineSpec: TIMELINE,
      dimensions: ["versionCode"],
      metrics: ["excessiveWakeupRate", "distinctUsers"],
      pageSize: 1000,
    });

    const params = calls[0]?.params as { name: string; requestBody: Record<string, unknown> };
    expect(calls[0]?.kind).toBe("wakeup.query");
    expect(params.name).toBe(name);
    expect(params.requestBody).toEqual({
      timelineSpec: TIMELINE,
      dimensions: ["versionCode"],
      metrics: ["excessiveWakeupRate", "distinctUsers"],
      pageSize: 1000,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.nextPageToken).toBe("W2");
  });

  it("retries a transient 503 on the excessive-wakeup query with the read policy", async () => {
    const { client } = clientWith();
    let calls = 0;
    const retrySettings: unknown[] = [];
    client.vitals.excessivewakeuprate.query = (_params, options) => {
      retrySettings.push(options);
      return ++calls === 1
        ? Promise.reject({ response: { status: 503 } })
        : Promise.resolve({ data: { rows: [] } });
    };

    expect(
      await queryExcessiveWakeupRate(
        client,
        { packageName: PKG },
        { sleep: () => Promise.resolve() },
      ),
    ).toEqual({ rows: [] });
    expect(calls).toBe(2);
    expect(retrySettings).toEqual([{ retry: false }, { retry: false }]);
  });

  it("rejects blank packageName and invalid pageSize for the excessive-wakeup path", async () => {
    const { client } = clientWith();
    await expect(getExcessiveWakeupRateMetricSet(client, " ")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      queryExcessiveWakeupRate(client, { packageName: PKG, pageSize: 100_001 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
