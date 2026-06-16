// SPDX-License-Identifier: Apache-2.0

import { dataValue, execute, fn } from "@openfn/language-common";
import { getRecord } from "../src/index.js";

execute(
  getRecord({
    dataset: "agri_registry",
    entity: "farmer",
    id: dataValue("farmer_id"),
    purpose: "https://demo.example.gov/purpose/nagdi/climate-smart-input-support",
    fields: ["id", "district", "registration_status"],
    as: "farmer",
    redactDataPaths: ["farmer_id"],
  }),

  fn((state) => {
    const farmer = state.data.farmer.record;

    return {
      ...state,
      data: {
        ...state.data,
        decision_input: {
          farmer_id: farmer.id,
          district: farmer.district,
          relay_request_id: state.data.farmer.request_id,
        },
      },
    };
  }),
);
