// SPDX-License-Identifier: Apache-2.0
// Credentials and the bound Requester profile belong only in configuration.casework.
import { execute } from "@openfn/language-common";
import { createOrRecoverReviewRequest } from "../src/index.js";

execute(
  createOrRecoverReviewRequest((state) => ({
    request: state.data.caseworkReviewRequest,
    expectedSubmissionDigest: state.data.caseworkSubmissionDigest,
    idempotencyKey: state.data.createIdempotencyKey,
    as: "acceptedReviewRequest",
  })),
);
