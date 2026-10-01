// SPDX-License-Identifier: Apache-2.0
import {
  addReviewNote,
  cancelReviewRequest,
  createOrRecoverReviewRequest,
  getReviewRequest,
  getReviewResult,
  listReviewHistory,
  listReviewResults,
} from "../src/index.js";

async function main() {
  const input = JSON.parse(await readStandardInput());
  const note = input.note ?? "Synthetic requester note for the OpenFn smoke.";
  let state = {
    configuration: {
      casework: {
        baseUrl: requiredString(input.baseUrl),
        token: requiredString(input.token),
        profile: input.profile ?? "requester",
      },
    },
    data: {},
  };
  state = await createOrRecoverReviewRequest({
    request: requiredObject(input.request),
    expectedSubmissionDigest: requiredString(input.expectedSubmissionDigest),
    idempotencyKey: requiredString(input.createIdempotencyKey),
    as: "accepted",
  })(state);
  succeeded(state.data.accepted);
  const accepted = requiredObject(state.data.accepted.value);

  state = await getReviewRequest({
    requestId: requiredString(accepted.requestId),
    as: "read",
  })(state);
  succeeded(state.data.read);
  state = await getReviewResult({ accepted, as: "beforeCancellation" })(state);
  resultState(state.data.beforeCancellation);
  state = await addReviewNote({
    requestId: accepted.requestId,
    idempotencyKey: requiredString(input.noteIdempotencyKey),
    note: requiredString(note),
    as: "noted",
  })(state);
  succeeded(state.data.noted);
  state = await listReviewHistory({
    requestId: accepted.requestId,
    limit: 25,
    as: "history",
  })(state);
  succeeded(state.data.history);
  const noteObserved = state.data.history.value.items.some(
    (entry) =>
      entry.eventId === state.data.noted.value.eventId &&
      entry.kind === "note" &&
      entry.detail?.audience === "requester" &&
      entry.detail?.note === note,
  );
  if (!noteObserved) throw new Error("requester note was not observed");

  state = await cancelReviewRequest({
    accepted,
    idempotencyKey: requiredString(input.cancelIdempotencyKey),
    cancellation: requiredObject(input.cancellation),
    as: "cancelled",
  })(state);
  succeeded(state.data.cancelled);
  const resultId = requiredString(state.data.cancelled.value?.result?.resultId);
  state = await listReviewResults({ limit: 25, as: "feed" })(state);
  succeeded(state.data.feed);
  const terminalObserved = state.data.feed.value.items.some(
    (entry) => entry.requestId === accepted.requestId && entry.resultId === resultId,
  );
  if (!terminalObserved) throw new Error("review result feed entry was not observed");
  state = await getReviewResult({ accepted, as: "result" })(state);
  if (state.data.result.branch !== "available") {
    throw new Error("cancelled review result was not available");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      operations: [
        "create_or_recover",
        "read_request",
        "read_result",
        "add_note",
        "read_history",
        "cancel",
        "list_results",
      ],
      noteObserved: true,
      terminalObserved: true,
    })}\n`,
  );
}

function requiredString(value) {
  if (typeof value !== "string" || !value.length) {
    throw new Error("required input missing");
  }
  return value;
}

function requiredObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("required input missing");
  }
  return value;
}

function succeeded(result) {
  if (result?.branch !== "succeeded") throw new Error("operation failed");
}

function resultState(result) {
  if (!["available", "pending", "concealed_or_unknown", "expired"].includes(result?.branch)) {
    throw new Error("result lookup failed");
  }
}

async function readStandardInput() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

main().catch(() => {
  process.stderr.write("Registry Casework smoke failed\n");
  process.exitCode = 1;
});
