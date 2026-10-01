# Registry Casework Requester adaptor

This private OpenFn adaptor wraps the Requester review API in the published
Registry Stack Node client 0.37.0. It creates or recovers review requests,
reads request state and correlated results, adds requester-visible notes, pages
requester-visible history and result feeds, and cancels an accepted request.

It exports no review-task, work-item, staff, supervisor, administrator, source
profile, accountability, or task-grant operation. Casework binds every request
to the authenticated producer and configured Requester profile. Workflow data
cannot choose a token or profile.

## Configuration

Store the credential in OpenFn configuration:

```json
{
  "casework": {
    "baseUrl": "https://casework.example.test/tenant",
    "token": "<requester bearer token>",
    "profile": "requester"
  }
}
```

`requestTimeoutMilliseconds`, `connectTimeoutMilliseconds`,
`maxResponseBytes`, `userAgent`, and `trustedRootCertificates` pass to the
maintained client. The token and profile never enter operation output. OpenFn
keeps configuration available during a composed job and removes it from final
job output.

## Requester operations

- `createOrRecoverReviewRequest` requires the complete native `request`, an
  independently computed `expectedSubmissionDigest`, and the caller's stable
  `idempotencyKey`. The adaptor does not derive a subject, convert display data
  into review context, or calculate a digest.
- `getReviewRequest` requires `requestId`.
- `getReviewResult` requires the complete accepted binding returned by create.
- `listReviewResults` accepts optional `cursor` and `limit`. Feed entries are
  completion signals. Retrieve the result using the matching accepted binding.
- `addReviewNote` requires `requestId`, a stable `idempotencyKey`, and `note`.
  The adaptor pins the note audience to `requester`.
- `listReviewHistory` requires `requestId`; `cursor` and `limit` are optional.
- `cancelReviewRequest` requires the complete accepted binding, a stable
  `idempotencyKey`, and the exact native `cancellation` object containing the
  same subject binding and a reason.

Create and cancel each make one maintained-client call. The adaptor never
generates an idempotency key, retries a mutation, replaces a digest, or rebuilds
an accepted binding.

A normal response has `{ branch: "succeeded", value, traceId? }`. Result lookup
instead preserves the native state as `available`, `pending`,
`concealed_or_unknown`, or `expired`; only `available` carries a result value.
Typed failures contain bounded diagnostics. Response detail, SDK messages,
credentials, configuration, and caller inputs are not copied into the result.

## Request body

The create request follows the native 0.37.0 contract. For submitted context:

```json
{
  "kind": "decision",
  "subject": {
    "source": "payments",
    "type": "batch",
    "id": "batch-0042",
    "version": "7",
    "digest": "sha256:<64 lowercase hex characters>"
  },
  "requesterReference": "batch-0042",
  "context": {
    "strategy": "submitted",
    "snapshot": {
      "summary": "Review batch 42"
    }
  }
}
```

The service returns an accepted binding containing `requestId`, the immutable
subject, the pinned policy, and `submissionDigest`. Persist that object intact
for result lookup, cancellation, and recovery.

## Cursor expiry

A typed `cursor.expired` response returns `branch: "cursor_expired"` without a
retry. Restart without a cursor and deduplicate against persisted `eventId`
values. Poll inside the configured retention period.

## Example

```js
import { execute } from "@openfn/language-common";
import {
  createOrRecoverReviewRequest,
  listReviewResults,
} from "@openfn/language-registry-casework";

execute(
  createOrRecoverReviewRequest((state) => ({
    request: state.data.reviewRequest,
    expectedSubmissionDigest: state.data.submissionDigest,
    idempotencyKey: state.data.createKey,
    as: "accepted",
  })),
  listReviewResults({ limit: 25, as: "completedReviews" }),
);
```

## Verification

The package check exercises fake bindings and the installed 0.37.0 native
client against a loopback HTTP service:

```sh
npm run check --workspace @openfn/language-registry-casework
```

For a deployed service, pass configuration plus the complete request,
submission digest, cancellation, and three caller-owned idempotency keys on
standard input. The smoke script prints only a success summary:

```sh
node packages/registry-casework/scripts/live-smoke.mjs < smoke-input.json
```
