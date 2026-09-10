# Registry Casework Requester adaptor

This private, unpublished OpenFn adaptor wraps the maintained Registry Stack
Casework Node client for service-to-service Requester work. It creates and reads
the caller's own hosted items, adds and reads the caller's notes, cancels the
caller's own item, and polls the caller's terminal feed.

It intentionally exports no staff claim, release, decision, actor-resolution,
source-feed, or outbound-delivery operation. Casework enforces ownership from
the credential issuer, subject, and configured Requester profile. Workflow data
cannot choose a token or profile.

## Candidate requirement

Development currently requires the locally built `@registrystack/client`
0.29.0 candidate from the Casework checkpoint. Do not assume an ordinary public
0.29.0 install contains the Casework namespace until that client is published
and verified. Keep this package private until then.

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

## Operations

- `createCaseworkItem` requires `kind`, `requesterReference`, `display`, and an
  explicit `idempotencyKey`.
- `getCaseworkItem` requires `itemId`.
- `addCaseworkNote` requires `itemId`, `expectedRevision`, `note`, and an
  explicit `idempotencyKey`.
- `listCaseworkNotes` requires `itemId`; `cursor` and `limit` are optional.
- `cancelCaseworkItem` requires `itemId`, `expectedRevision`, `reason`, and an
  explicit `idempotencyKey`.
- `pollCaseworkResults` accepts an optional `cursor` and `limit`.

Each operation makes one maintained-client call and writes a result under its
default key or the bounded `as` name. A success has
`{ branch: "succeeded", value, traceId? }`. Typed failures contain only bounded
diagnostics. Response detail, SDK messages, credentials, configuration, and
caller inputs are not copied into the result.

Idempotency conflicts are returned as `branch: "conflict"`; the adaptor never
generates a replacement key or retries silently. Keep each key with the logical
create, note, or cancellation until its outcome is resolved.

## Cursor expiry

A typed `cursor.expired` response returns `branch: "cursor_expired"` without a
retry. The result identifies the explicit recovery:

```json
{
  "recovery": {
    "action": "restart_without_cursor",
    "deduplicateBy": "eventId"
  }
}
```

Restart the terminal poll without `cursor`, then deduplicate against persisted
`eventId` values. Notes use `noteId` instead. Poll within the configured
terminal retention period; an expired item is no longer available.

## Example

```js
import { execute } from "@openfn/language-common";
import { createCaseworkItem, pollCaseworkResults } from "@openfn/language-registry-casework";

execute(
  createCaseworkItem((state) => ({
    kind: state.data.caseworkKind,
    requesterReference: state.data.requestReference,
    display: state.data.caseworkDisplay,
    idempotencyKey: state.data.createKey,
    as: "createdCasework",
  })),
  pollCaseworkResults({ limit: 25, as: "terminalResults" }),
);
```

## Verification

The package check uses fake maintained-client bindings and needs no service:

```sh
npm run check --workspace @openfn/language-registry-casework
```

After installing the local Casework client candidate into an isolated package
tree, send smoke configuration on standard input. The script prints only a
success summary and prints no credential, item, note, or response data:

```sh
printf '%s' '{"baseUrl":"http://127.0.0.1:8084","token":"<requester token>","profile":"requester"}' \
  | node packages/registry-casework/scripts/live-smoke.mjs
```
