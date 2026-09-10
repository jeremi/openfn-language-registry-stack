// SPDX-License-Identifier: Apache-2.0
import {
  addCaseworkNote,
  cancelCaseworkItem,
  createCaseworkItem,
  getCaseworkItem,
  listCaseworkNotes,
  pollCaseworkResults,
} from "../src/index.js";

async function main() {
  const input = JSON.parse(await readStandardInput());
  const note = "Synthetic requester note for the OpenFn smoke.";
  let state = {
    configuration: {
      casework: {
        baseUrl: required(input.baseUrl),
        token: required(input.token),
        profile: input.profile ?? "requester",
      },
    },
    data: {},
  };
  state = await createCaseworkItem({
    kind: input.kind ?? "decision",
    requesterReference:
      input.requesterReference ?? "openfn-casework-live-smoke-001",
    display: input.display ?? {
      summary: "Review the synthetic OpenFn smoke request",
      reference: "openfn-casework-live-smoke-001",
    },
    idempotencyKey: "openfn-casework-live-smoke-create-v1",
    as: "created",
  })(state);
  succeeded(state.data.created);
  const itemId = required(state.data.created.value?.itemId);

  state = await getCaseworkItem({ itemId, as: "read" })(state);
  succeeded(state.data.read);
  state = await addCaseworkNote({
    itemId,
    expectedRevision: state.data.read.value.revision,
    idempotencyKey: "openfn-casework-live-smoke-note-v1",
    note,
    as: "noted",
  })(state);
  succeeded(state.data.noted);
  state = await listCaseworkNotes({ itemId, limit: 25, as: "notes" })(state);
  succeeded(state.data.notes);
  const noteObserved = state.data.notes.value.items.some(
    (entry) => entry.itemId === itemId && entry.note === note,
  );
  if (!noteObserved) throw new Error("requester note was not observed");
  state = await cancelCaseworkItem({
    itemId,
    expectedRevision: state.data.noted.value.revision,
    idempotencyKey: "openfn-casework-live-smoke-cancel-v1",
    reason: "Synthetic smoke completed.",
    as: "cancelled",
  })(state);
  succeeded(state.data.cancelled);
  state = await pollCaseworkResults({ limit: 25, as: "terminal" })(state);
  succeeded(state.data.terminal);

  const terminalObserved = state.data.terminal.value.items.some(
    (entry) => entry.eventId === state.data.cancelled.value.eventId,
  );
  if (!terminalObserved) throw new Error("terminal result was not observed");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      operations: ["create", "read", "note", "read_notes", "cancel", "poll"],
      noteObserved: true,
      terminalObserved: true,
    })}\n`,
  );
}

function required(value) {
  if (typeof value !== "string" || !value.length) throw new Error("required input missing");
  return value;
}

function succeeded(result) {
  if (result?.branch !== "succeeded") throw new Error("operation failed");
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
