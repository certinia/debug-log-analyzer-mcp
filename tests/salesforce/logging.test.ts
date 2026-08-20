/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

const DISABLE = "SF_DISABLE_LOG_FILE";
const STDERR = "SF_LOG_STDERR";

/** The module writes to the environment, so each case gets it back as it was. */
describe("Salesforce logging", () => {
  const before = {
    [DISABLE]: process.env[DISABLE],
    [STDERR]: process.env[STDERR],
  };

  beforeEach(() => {
    jest.resetModules();
    delete process.env[DISABLE];
    delete process.env[STDERR];
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  const load = async () => await import("../../src/salesforce/logging");

  it("should turn the log off when nothing asked for it", async () => {
    await load();

    expect(process.env[DISABLE]).toBe("true");
    expect(process.env[STDERR]).toBe("true");
  });

  it("should keep the log for a caller that asked for it", async () => {
    process.env[DISABLE] = "false";

    await load();

    expect(process.env[DISABLE]).toBe("false");
  });

  // A wrapper forwarding a variable it has not set gives an empty string, which
  // core reads as "log", not as "unset".
  it("should turn the log off when the setting is empty", async () => {
    process.env[DISABLE] = "";
    process.env[STDERR] = "";

    await load();

    expect(process.env[DISABLE]).toBe("true");
    expect(process.env[STDERR]).toBe("true");
  });
});
