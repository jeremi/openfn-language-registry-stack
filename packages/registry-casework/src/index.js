// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import { createCaseworkOperations } from "./operations.js";

export * from "@openfn/language-common";
export { CaseworkCallerError } from "./operations.js";

const require = createRequire(import.meta.url);
const operations = createCaseworkOperations(() => {
  const bindings = require("@registrystack/client").casework;
  if (
    !bindings ||
    typeof bindings.CaseworkClient !== "function" ||
    typeof bindings.CaseworkClientError !== "function"
  ) {
    throw new Error("Registry Casework client bindings are unavailable");
  }
  return bindings;
});

export const {
  createCaseworkItem,
  getCaseworkItem,
  addCaseworkNote,
  listCaseworkNotes,
  cancelCaseworkItem,
  pollCaseworkResults,
} = operations;
