import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as adaptor from "../src/index.js";
import {
  CaseworkCallerError,
  createCaseworkOperations,
} from "../src/operations.js";

class FakeCaseworkClientError extends Error {
  constructor(fields) {
    super(fields.message ?? "synthetic client failure");
    Object.assign(this, fields);
  }
}

function fakeOperations(handlers = {}) {
  const calls = [];
  class FakeCaseworkClient {
    constructor(configuration) {
      calls.push(["constructor", configuration]);
    }
  }
  for (const method of [
    "createHostedItem",
    "getHostedItem",
    "addHostedNote",
    "requesterHostedNotes",
    "cancelHostedItem",
    "hostedTerminalItems",
  ]) {
    FakeCaseworkClient.prototype[method] = async function (...args) {
      calls.push([method, ...args]);
      if (handlers[method]) return handlers[method](...args);
      return {
        kind: "complete",
        value: { method, revision: 2, items: [] },
        traceId: "trace-synthetic-1",
      };
    };
  }
  return {
    calls,
    operations: createCaseworkOperations(() => ({
      CaseworkClient: FakeCaseworkClient,
      CaseworkClientError: FakeCaseworkClientError,
    })),
  };
}

function state() {
  return {
    configuration: {
      casework: {
        baseUrl: "https://casework.example.test/tenant",
        token: "synthetic-requester-secret",
        profile: "requester",
        maxResponseBytes: 1_000_000,
      },
    },
    data: { input: "retained" },
  };
}

test("adaptor reexports common operations used by Lightning autoimports", () => {
  assert.equal(typeof adaptor.fn, "function");
  assert.equal(typeof adaptor.execute, "function");
  for (const operation of [
    "createCaseworkItem",
    "getCaseworkItem",
    "addCaseworkNote",
    "listCaseworkNotes",
    "cancelCaseworkItem",
    "pollCaseworkResults",
  ]) {
    assert.equal(typeof adaptor[operation], "function");
  }
  for (const forbidden of [
    "claimWorkItem",
    "releaseWorkItem",
    "decideWorkItem",
    "hostedAccountabilityRecord",
    "listWorkItems",
  ]) {
    assert.equal(forbidden in adaptor, false);
  }
  assert.throws(() => createCaseworkOperations(), CaseworkCallerError);
});

test("Requester operations preserve exact keys, revisions and maintained method shapes", async () => {
  const { calls, operations } = fakeOperations();
  const initial = state();
  let result = await operations.createCaseworkItem((current) => ({
    kind: "decision",
    requesterReference: "batch-0042",
    display: { summary: current.data.input },
    idempotencyKey: "create-key-exact-001",
    as: "created",
  }))(initial);
  result = await operations.getCaseworkItem({ itemId: "item-1", as: "read" })(result);
  result = await operations.addCaseworkNote({
    itemId: "item-1",
    expectedRevision: 7,
    idempotencyKey: "note-key-exact-002",
    note: "Requester context.",
    as: "noted",
  })(result);
  result = await operations.listCaseworkNotes({
    itemId: "item-1",
    cursor: "notes-cursor-1",
    limit: 12,
    as: "notes",
  })(result);
  result = await operations.cancelCaseworkItem({
    itemId: "item-1",
    expectedRevision: 8,
    idempotencyKey: "cancel-key-exact-003",
    reason: "No longer required.",
    as: "cancelled",
  })(result);
  result = await operations.pollCaseworkResults({
    cursor: "terminal-cursor-1",
    limit: 25,
    as: "terminal",
  })(result);

  assert.deepEqual(calls, [
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "createHostedItem",
      "synthetic-requester-secret",
      "requester",
      "create-key-exact-001",
      {
        kind: "decision",
        requesterReference: "batch-0042",
        display: { summary: "retained" },
      },
    ],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    ["getHostedItem", "synthetic-requester-secret", "requester", "item-1"],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "addHostedNote",
      "synthetic-requester-secret",
      "requester",
      "item-1",
      7,
      "note-key-exact-002",
      { note: "Requester context." },
    ],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "requesterHostedNotes",
      "synthetic-requester-secret",
      "requester",
      "item-1",
      { cursor: "notes-cursor-1", limit: 12 },
    ],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "cancelHostedItem",
      "synthetic-requester-secret",
      "requester",
      "item-1",
      8,
      "cancel-key-exact-003",
      { reason: "No longer required." },
    ],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "hostedTerminalItems",
      "synthetic-requester-secret",
      "requester",
      { cursor: "terminal-cursor-1", limit: 25 },
    ],
  ]);
  assert.equal(result.configuration, initial.configuration);
  assert.equal(result.data.input, "retained");
  assert.equal(result.data.terminal.branch, "succeeded");
  assert.equal(JSON.stringify(result.data).includes("synthetic-requester-secret"), false);
});

test("terminal cursor expiry is typed, redacted and never retried silently", async () => {
  let attempts = 0;
  const { operations } = fakeOperations({
    hostedTerminalItems: (_token, _profile, query) => {
      attempts += 1;
      if (query.cursor) {
        throw new FakeCaseworkClientError({
          kind: "problem",
          code: "cursor.expired",
          status: 400,
          traceId: "trace-cursor-expired",
          detail: "secret-response-canary",
        });
      }
      return {
        kind: "complete",
        value: { items: [{ eventId: "event-1" }], status: "complete" },
        traceId: "trace-restarted",
      };
    },
  });

  let result = await operations.pollCaseworkResults({
    cursor: "expired-cursor",
    limit: 25,
  })(state());
  assert.equal(attempts, 1);
  assert.deepEqual(result.data.caseworkTerminal, {
    branch: "cursor_expired",
    problem: {
      code: "cursor.expired",
      status: 400,
      retryable: false,
    },
    traceId: "trace-cursor-expired",
    recovery: {
      action: "restart_without_cursor",
      deduplicateBy: "eventId",
    },
  });
  assert.equal(JSON.stringify(result).includes("secret-response-canary"), false);

  result = await operations.pollCaseworkResults({ limit: 25, as: "restarted" })(
    result,
  );
  assert.equal(attempts, 2);
  assert.equal(result.data.restarted.branch, "succeeded");
  assert.equal(result.data.restarted.value.items[0].eventId, "event-1");
});

test("note cursor recovery names noteId and caller mistakes make no client call", async () => {
  let noteCalls = 0;
  const { calls, operations } = fakeOperations({
    requesterHostedNotes: () => {
      noteCalls += 1;
      throw new FakeCaseworkClientError({
        kind: "problem",
        code: "cursor.expired",
        status: 400,
      });
    },
  });
  const expired = await operations.listCaseworkNotes({
    itemId: "item-1",
    cursor: "expired-notes",
  })(state());
  assert.equal(noteCalls, 1);
  assert.equal(expired.data.caseworkNotes.recovery.deduplicateBy, "noteId");

  const before = calls.length;
  const missingKey = await operations.createCaseworkItem({
    kind: "decision",
    requesterReference: "batch-1",
    display: {},
  })(state());
  assert.equal(missingKey.data.caseworkCreated.branch, "invalid_request");
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1)[0], "constructor");
});

test("typed conflicts and validation expose only bounded diagnostics", async () => {
  const { operations } = fakeOperations({
    cancelHostedItem: () => {
      throw new FakeCaseworkClientError({
        kind: "problem",
        code: "idempotency.key-reused",
        status: 409,
        detail: "secret-cancellation-canary",
        message: "secret-message-canary",
        validation: { path: "/reason", reason: "text_invalid" },
      });
    },
  });
  const result = await operations.cancelCaseworkItem({
    itemId: "item-1",
    expectedRevision: 4,
    idempotencyKey: "same-key-is-preserved",
    reason: "Stop.",
  })(state());
  assert.deepEqual(result.data.caseworkCancellation, {
    branch: "conflict",
    problem: {
      code: "idempotency.key-reused",
      status: 409,
      retryable: false,
    },
    validation: { path: "/reason", reason: "text_invalid" },
  });
  assert.equal(JSON.stringify(result).includes("secret-cancellation-canary"), false);
  assert.equal(JSON.stringify(result).includes("secret-message-canary"), false);
});

test("package stays private and pins the local candidate contract version", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const schema = JSON.parse(
    readFileSync(new URL("../configuration-schema.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies["@registrystack/client"], "0.29.0");
  assert.deepEqual(schema.required, ["baseUrl", "token", "profile"]);
  assert.equal(schema.properties.token.writeOnly, true);
});

test("oversized credentials are rejected without construction or disclosure", async () => {
  const { calls, operations } = fakeOperations();
  const configured = state();
  configured.configuration.casework.token = "secret-canary".repeat(2_000);
  const result = await operations.getCaseworkItem({ itemId: "item-1" })(configured);
  assert.equal(result.data.caseworkItem.branch, "invalid_request");
  assert.equal(result.data.caseworkItem.problem.code, "configuration.casework.token.too_long");
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(result.data).includes("secret-canary"), false);
});
