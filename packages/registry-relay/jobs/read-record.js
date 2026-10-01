// SPDX-License-Identifier: Apache-2.0

import { dataValue, execute, fn } from "@openfn/language-common";
import { getRecord } from "../src/index.js";

execute(
  getRecord({
    resource: "farmers",
    recordIdentifier: dataValue("farmer_id"),
    accessProfile: "programme-reader",
    fields: ["district", "registrationStatus"],
    as: "farmer",
    redactDataPaths: ["farmer_id"],
  }),

  fn((state) => {
    const farmer = state.data.farmer.value.data;

    return {
      ...state,
      data: {
        ...state.data,
        decision_input: {
          farmer_id: farmer.recordIdentifier,
          district: farmer.domainData.district,
          relay_trace_id: state.data.farmer.traceId,
        },
      },
    };
  }),
);
