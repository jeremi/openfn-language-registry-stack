import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import compile from "@openfn/compiler";
import run from "@openfn/runtime";
import {
  RelayCallerError,
  buildRelayRequest,
  discoverDatasets,
  getRecord,
  listRecords,
  queryAggregate,
  redactRelayProblem,
} from "../src/index.js";

const baseState = Object.freeze({
  data: {
    request_id: "wf-req-1",
    farmer_id: "FARMER-1001",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
  },
  configuration: {
    relay_base_url: "https://relay.example",
    token: "secret-token",
  },
});
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const languageCommonRoot = findDependencyRoot(packageRoot, "@openfn/language-common");

test("getRecord sends bearer auth, purpose, request id, traceparent, and projected fields", async () => {
  const calls = [];
  const state = await getRecord({
    dataset: "nagdi_agriculture",
    entity: "farmer",
    id: { valueFrom: "farmer_id" },
    purpose: "https://demo.example.gov/purpose/nagdi/climate-smart-input-support",
    fields: ["id", "district"],
    as: "farmer",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(
        { id: "FARMER-1001", district: "north" },
        { headers: { etag: "\"abc\"", "x-request-id": "relay-req-1" } },
      );
    },
  })(baseState);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://relay.example/v1/datasets/nagdi_agriculture/entities/farmer/records/FARMER-1001?fields=id%2Cdistrict",
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].init.headers["Data-Purpose"], "https://demo.example.gov/purpose/nagdi/climate-smart-input-support");
  assert.equal(calls[0].init.headers["X-Request-Id"], "wf-req-1");
  assert.equal(calls[0].init.headers.traceparent, baseState.data.traceparent);
  assert.deepEqual(state.data.farmer, {
    branch: "succeeded",
    record: { id: "FARMER-1001", district: "north" },
    request_id: "relay-req-1",
    purpose: "https://demo.example.gov/purpose/nagdi/climate-smart-input-support",
    etag: "\"abc\"",
  });
  assert.equal("farmer_id" in state.data, false);
  assert.equal("configuration" in state, false);
  assert.equal(JSON.stringify(state).includes("secret-token"), false);
});

test("getRecord requires a purpose for row reads", async () => {
  await assert.rejects(
    () =>
      getRecord({
        dataset: "nagdi_agriculture",
        entity: "farmer",
        id: "FARMER-1001",
        fetch: async () => jsonResponse({}),
      })(baseState),
    (error) => error instanceof RelayCallerError && error.code === "value.required",
  );
});

test("listRecords requires explicit limit and filters by default", async () => {
  await assert.rejects(
    () =>
      listRecords({
        dataset: "nagdi_agriculture",
        entity: "farmer",
        purpose: "purpose",
        limit: 50,
        fetch: async () => jsonResponse({ data: [], pagination: { has_more: false, next_cursor: null } }),
      })(baseState),
    (error) => error instanceof RelayCallerError && error.code === "filters.required",
  );

  await assert.rejects(
    () =>
      listRecords({
        dataset: "nagdi_agriculture",
        entity: "farmer",
        purpose: "purpose",
        filters: { district: "north" },
        fetch: async () => jsonResponse({ data: [], pagination: { has_more: false, next_cursor: null } }),
      })(baseState),
    (error) => error instanceof RelayCallerError && error.code === "limit.required",
  );
});

test("listRecords encodes filters, pagination, fields, and expansions", async () => {
  const calls = [];
  const state = await listRecords({
    dataset: "nagdi_agriculture",
    entity: "farmer",
    purpose: "purpose",
    filters: {
      district: "north",
      "id.in": ["FARMER-1001", "FARMER-1002"],
    },
    fields: ["id", "district"],
    expand: ["holding"],
    limit: 2,
    cursor: "cursor-1",
    as: "farmers",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        data: [{ id: "FARMER-1001" }],
        pagination: { has_more: true, next_cursor: "cursor-2" },
      });
    },
  })(baseState);

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/datasets/nagdi_agriculture/entities/farmer/records");
  assert.equal(url.searchParams.get("district"), "north");
  assert.equal(url.searchParams.get("id.in"), "FARMER-1001,FARMER-1002");
  assert.equal(url.searchParams.get("fields"), "id,district");
  assert.equal(url.searchParams.get("expand"), "holding");
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("cursor"), "cursor-1");
  assert.deepEqual(state.data.farmers.records, [{ id: "FARMER-1001" }]);
  assert.deepEqual(state.data.farmers.pagination, { has_more: true, next_cursor: "cursor-2" });
});

test("queryAggregate sends Relay aggregate query body", async () => {
  const calls = [];
  const state = await queryAggregate({
    dataset: "nagdi_agriculture",
    aggregate: "farmers_by_district",
    purpose: "purpose",
    dimensions: ["district"],
    measures: ["farmer_count"],
    filters: { season: ["2026"] },
    maxRows: 100,
    as: "district_summary",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        dataset_id: "nagdi_agriculture",
        aggregate_id: "farmers_by_district",
        observations: [{ district: "north", farmer_count: 12 }],
        completeness: { complete: true, truncated: false },
        disclosure_control: { method: ["k-anonymity"] },
        freshness: { computed_at: "2026-06-01T00:00:00Z" },
        links: [],
        structure: { dimensions: [], measures: [] },
      });
    },
  })(baseState);

  assert.equal(calls[0].url, "https://relay.example/v1/datasets/nagdi_agriculture/aggregates/farmers_by_district/query?f=json");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    filters: { season: ["2026"] },
    format: "json",
    group_by: ["district"],
    max_rows: 100,
    measures: ["farmer_count"],
  });
  assert.deepEqual(state.data.district_summary.observations, [{ district: "north", farmer_count: 12 }]);
  assert.deepEqual(state.data.district_summary.completeness, { complete: true, truncated: false });
});

test("discoverDatasets does not send Data-Purpose", async () => {
  const calls = [];
  const state = await discoverDatasets({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ data: [{ dataset_id: "nagdi_agriculture" }] });
    },
  })(baseState);

  assert.equal(calls[0].url, "https://relay.example/v1/datasets");
  assert.equal("Data-Purpose" in calls[0].init.headers, false);
  assert.deepEqual(state.data.datasets.datasets, [{ dataset_id: "nagdi_agriculture" }]);
});

test("Problem Details are mapped without leaking detail", async () => {
  const state = await getRecord({
    dataset: "nagdi_agriculture",
    entity: "farmer",
    id: "FARMER-1001",
    purpose: "purpose",
    fetch: async () =>
      jsonResponse(
        {
          type: "https://relay.example/problems/entity.filter_required",
          title: "Filter required",
          status: 400,
          detail: "secret FARMER-1001",
          code: "entity.filter_required",
          request_id: "problem-req-1",
        },
        { status: 400, headers: { "x-request-id": "problem-req-1" } },
      ),
  })(baseState);

  assert.equal(state.data.record.branch, "filter_required");
  assert.deepEqual(state.data.record.problem, {
    code: "entity.filter_required",
    status: 400,
    title: "Filter required",
    retryable: false,
  });
  assert.equal(JSON.stringify(state).includes("secret FARMER-1001"), false);
});

test("429 and 503 responses become retryable infrastructure branches", async () => {
  for (const status of [429, 503]) {
    const state = await getRecord({
      dataset: "nagdi_agriculture",
      entity: "farmer",
      id: "FARMER-1001",
      purpose: "purpose",
      fetch: async () =>
        jsonResponse(
          { title: "Retry later", status, code: "rate_limited", request_id: "retry-req" },
          { status, headers: { "retry-after": "3" } },
        ),
    })(baseState);

    assert.equal(state.data.record.branch, "retryable_infrastructure");
    assert.equal(state.data.record.problem.retryable, true);
    assert.equal(state.data.record.retry_after_seconds, 3);
  }
});

test("transport errors are redacted retryable infrastructure branches", async () => {
  const state = await getRecord({
    dataset: "nagdi_agriculture",
    entity: "farmer",
    id: "FARMER-1001",
    purpose: "purpose",
    fetch: async () => {
      throw new Error("socket failed for secret FARMER-1001");
    },
  })(baseState);

  assert.equal(state.data.record.branch, "retryable_infrastructure");
  assert.equal(state.data.record.problem.code, "transport.error");
  assert.equal(JSON.stringify(state).includes("secret FARMER-1001"), false);
});

test("304 responses return not_modified with response validators", async () => {
  const state = await getRecord({
    dataset: "nagdi_agriculture",
    entity: "farmer",
    id: "FARMER-1001",
    purpose: "purpose",
    ifNoneMatch: "\"abc\"",
    fetch: async (_url, init) => {
      assert.equal(init.headers["If-None-Match"], "\"abc\"");
      return {
        status: 304,
        headers: { etag: "\"abc\"" },
        text: async () => "",
      };
    },
  })(baseState);

  assert.equal(state.data.record.branch, "not_modified");
  assert.equal(state.data.record.etag, "\"abc\"");
});

test("buildRelayRequest rejects absolute escape-hatch paths", () => {
  assert.throws(
    () =>
      buildRelayRequest(baseState, {
        path: "https://evil.example/v1/datasets",
      }),
    (error) => error instanceof RelayCallerError && error.code === "path.absolute",
  );
});

test("redactRelayProblem drops detail", () => {
  assert.deepEqual(
    redactRelayProblem({
      title: "Problem",
      status: 400,
      detail: "secret",
      code: "request.failed",
      request_id: "req-1",
    }),
    {
      title: "Problem",
      status: 400,
      code: "request.failed",
      request_id: "req-1",
    },
  );
});

test("template imports helper operations and avoids generic HTTP helpers", () => {
  const template = readFileSync(new URL("../jobs/read-record.js", import.meta.url), "utf8");

  assert.match(template, /getRecord/);
  assert.match(template, /import\s+\{\s*dataValue,\s*execute,\s*fn\s*\}\s+from\s+["']@openfn\/language-common["']/);
  assert.match(template, /from\s+["']\.\.\/src\/index\.js["']/);
  assert.doesNotMatch(template, /from\s+["']@openfn\/language-http["']/);
  assert.doesNotMatch(template, /Authorization/);
});

test("compiled OpenFn template runs through the OpenFn runtime and calls Relay once", async () => {
  const template = readFileSync(new URL("../jobs/read-record.js", import.meta.url), "utf8");
  const { code } = compile(template);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(
      { id: "FARMER-1001", district: "north", registration_status: "active" },
      { headers: { "x-request-id": "relay-runtime-req" } },
    );
  };

  try {
    const result = await run(
      {
        workflow: {
          steps: [{ id: "read-record", expression: code }],
          start: "read-record",
        },
        options: { start: "read-record" },
      },
      baseState,
      {
        linker: {
          modules: {
            "@openfn/language-common": { path: languageCommonRoot },
            "../src/index.js": { path: packageRoot },
          },
          cacheKey: `openfn-relay-test-${process.pid}-${Date.now()}`,
        },
        statePropsToRemove: [],
      },
    );

    assert.equal(result.errors, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://relay.example/v1/datasets/nagdi_agriculture/entities/farmer/records/FARMER-1001?fields=id%2Cdistrict%2Cregistration_status");
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
    assert.equal(result.data.farmer.branch, "succeeded");
    assert.equal(result.data.farmer.request_id, "relay-runtime-req");
    assert.equal(result.data.decision_input.district, "north");
    assert.equal("farmer_id" in result.data, false);
    assert.equal("configuration" in result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function findDependencyRoot(start, packageName) {
  let current = resolve(start);
  while (true) {
    const candidate = resolve(current, "node_modules", packageName);
    if (existsSync(resolve(candidate, "package.json"))) {
      return candidate;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      throw new Error(`dependency not found: ${packageName}`);
    }
    current = parent;
  }
}

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}
