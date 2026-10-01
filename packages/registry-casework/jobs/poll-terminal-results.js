// SPDX-License-Identifier: Apache-2.0
// Persist nextCursor only after a succeeded page. Handle cursor_expired explicitly.
import { execute } from "@openfn/language-common";
import { listReviewResults } from "../src/index.js";

execute(
  listReviewResults((state) => ({
    cursor: state.data.caseworkResultCursor,
    limit: 25,
    as: "reviewResults",
  })),
);
