# OpenFn Language Registry Stack

OpenFn language helpers for Registry Stack services, starting with Registry
Notary as a trust decision service.

This is not an official OpenFn adaptor. The package is intentionally separate
from the Registry Notary source-sidecar helper because it is for OpenFn
workflows that call Notary as a client.

## Install

```sh
npm install @jeremi/openfn-language-registry-stack
```

Configure an OpenFn credential with:

- `notary_base_url`: Registry Notary service base URL.
- `token`: bearer token for the Notary caller credential.
- `openfn_request_fingerprint_key`: local HMAC key used for replay-safe helper
  fingerprints. This value is not sent to Registry Notary.
- `openfn_target_fingerprint_key`: optional separate HMAC key for the
  `target_fingerprint` audit value.

## Template

`jobs/evaluate-claim-http.js` shows the first safe HTTP workflow shape. It uses
the helper instead of `@openfn/language-http` for the Notary request because
`@openfn/language-http@7.3.1` can log non-2xx response bodies before workflow
code can redact Problem Details `detail`.

- prepare a minimized `POST /v1/evaluations` body;
- send `Authorization`, `Data-Purpose`, and `X-Request-Id`;
- propagate `traceparent` when upstream workflow state provides one;
- read `EvaluationResponse.results` as an array;
- take `evaluation_id` from the selected `ClaimResultView`;
- branch through helper output;
- strip request material, raw subject identifiers, and secret-backed
  configuration from final state.

## Value Claims

When a workflow needs a fact such as farmed land size, model it as a Notary
value claim instead of querying the source Relay from OpenFn. The Notary remains
the evidence boundary, and OpenFn only consumes the minimized claim result.

```js
const evaluationOptions = {
  claimId: "farmer-registration-and-land-size",
  purpose: "https://demo.example.gov/purpose/nagdi/climate-smart-input-support",
  disclosure: "value",
  target: {
    type: "Farmer",
    identifiers: [{ scheme: "farmer_id", valueFrom: "farmer_id" }],
  },
};

execute(
  fn((state) => callNotaryEvaluation(state, evaluationOptions)),
  fn((state) => {
    const evidence = state.data.notary.value;
    const farmedAreaHa = Number(evidence.farmed_land_size_hectares ?? 0);
    const approved =
      evidence.is_registered_farmer === true &&
      evidence.active_holding === true &&
      farmedAreaHa >= 1 &&
      farmedAreaHa <= 3;

    return {
      ...state,
      data: {
        decision: {
          status: approved ? "approved" : "manual_review",
          evidence: {
            holding_id: evidence.holding_id,
            farmed_area_ha: farmedAreaHa,
            district: evidence.district,
            notary_evaluation_id: state.data.notary.evaluation_id,
          },
        },
      },
    };
  }),
);
```

## Auditability And Signature Boundary

The helper exposes audit correlation fields in final workflow state:
`request_id`, `evaluation_id`, `purpose`, selected claim id, branch, and an
HMAC `target_fingerprint`. It also forwards `traceparent` to Notary when the
incoming OpenFn state contains one.

This package does not verify cryptographic signatures on evaluation responses.
If a workflow consumes an issued SD-JWT VC credential, verify that credential
separately against trusted JWKS and caller policy. The Rust Notary client has
`registry_notary_client::verifier::verify_sd_jwt_vc`; this JavaScript package
does not wrap it.

OpenFn dependency:

```text
@openfn/language-common@3.3.3
@openfn/compiler@1.2.5
@openfn/runtime@1.9.3
```

Profile assumption: matching-error collapse is enabled. Production
workflows should expect `evidence.not_available` unless the operator has
explicitly exposed granular matching errors in a controlled profile.

## Verification

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```
