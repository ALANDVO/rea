import { EventEmitter } from "node:events";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { HopperFixtureLauncher } from "./hopperClient.fixture.js";

class ObservedProcess extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  exitCode: number | null = null;
  readonly signalCode = null;

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }

  kill(): boolean {
    this.exit(0);
    return true;
  }
}

class LifecycleLauncher implements BridgeLauncher {
  readonly fixture = new HopperFixtureLauncher();
  observed = new ObservedProcess();

  constructor(readonly owned: boolean) {}

  async launch(session: BridgeSession) {
    this.observed = new ObservedProcess();
    await this.fixture.launch(session);
    return ok({
      process: this.observed,
      ownsProcessLifetime: this.owned,
      shutdownMode: "bridge-request" as const,
    });
  }
}

const start = async (owned: boolean) => {
  const launcher = new LifecycleLauncher(owned);
  const client = new HopperClient({ launcher, startupTimeoutMs: 10_000 });
  onTestFinished(async () => {
    await client.close();
    for (const child of launcher.fixture.processes) child.kill();
  });
  expect((await client.start()).ok).toBe(true);
  return { client, launcher };
};

describe("Hopper provider lifecycle health", () => {
  it("keeps a live bridge healthy after a non-owning launcher helper exits", async () => {
    const { client, launcher } = await start(false);
    launcher.observed.exit(0);
    expect(client.operationHealth().state).toBe("idle");
    expect(await client.callTool("echo", { label: "GUI still alive" })).toEqual(
      {
        ok: true,
        value: { label: "GUI still alive" },
      },
    );
    expect(client.operationHealth().state).toBe("idle");
  });

  it("settles disconnected requests without attributing the helper exit to the GUI", async () => {
    const { client, launcher } = await start(false);
    launcher.observed.exit(0);
    const pending = client.callTool("hang");
    await launcher.fixture.waitForRequest("hang");
    launcher.fixture.processes.at(-1)?.kill("SIGKILL");
    await vi.waitFor(() =>
      expect(client.operationHealth().state).toBe("unreachable"),
    );
    expect(await pending).toMatchObject({
      ok: false,
      error: {
        providerState: "unreachable",
        exitCode: null,
        operation: "hang",
      },
    });
    expect(client.operationHealth()).toMatchObject({
      state: "unreachable",
      exitCode: null,
    });
    expect(
      await client.callTool("procedure_pseudo_code", { procedure: "main" }),
    ).toMatchObject({
      ok: false,
      error: {
        providerState: "unreachable",
        stage: "decompilation",
        operation: "procedure_pseudo_code",
      },
    });
  });

  it("retains an observed exit when an earlier successful reply resumes afterward", async () => {
    const { client, launcher } = await start(true);
    const first = client.callTool("echo", { gate: "before-exit" });
    const request = await launcher.fixture.waitForRequest(
      "echo",
      "before-exit",
    );
    const controller = new AbortController();
    const second = client.callTool(
      "hang",
      {},
      {
        signal: controller.signal,
        progress: {
          report: (update) => {
            if (update.message === "hang started on Hopper's serial bridge") {
              controller.abort();
              launcher.observed.exit(7);
            }
            return Promise.resolve();
          },
        },
      },
    );
    await vi.waitFor(() =>
      expect(client.requestActivity()?.queuedRequests).toBe(1),
    );
    await launcher.fixture.release(request);
    expect((await first).ok).toBe(true);
    expect(await second).toMatchObject({
      ok: false,
      error: { _tag: "HopperCancelledError" },
    });
    expect(client.operationHealth()).toMatchObject({
      state: "exited",
      exitCode: 7,
    });
    await client.close();
    expect((await client.start()).ok).toBe(true);
    expect(client.operationHealth().state).toBe("idle");
  });
});
