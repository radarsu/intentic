import { defineStack } from "@puristic/deploy-core";
import { apply } from "@puristic/deploy-engine";
import { env } from "@puristic/deploy-protocol";
import { expect, test } from "vitest";

import { createHostProvider } from "./host.js";
import type { SshExecutor } from "./ssh.js";

// A reachable, Docker-ready host: docker version succeeds, the route command yields the internal ip.
const reachable: SshExecutor = {
    connect: async () => ({
        exec: async (command) =>
            command.includes("docker") ? { stdout: "24.0.0", stderr: "", code: 0 } : { stdout: "10.0.0.5\n", stderr: "", code: 0 },
        dispose: async () => {},
    }),
};

test("host-only stack: the engine reconciles an owned host to noop and records its facts", async () => {
    const graph = defineStack((i) => {
        i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") });
    });

    const result = await apply(graph, {
        providers: { host: createHostProvider(reachable) },
        env: { HOST_SSH_KEY: "key-material" },
        log: () => {},
    });

    // An owned host already exists, so read returns it and the engine reports noop (not create).
    expect(result.steps).toEqual([{ id: "host", type: "host", action: "noop" }]);
    expect(result.outputs["host"]).toEqual({ internalIp: "10.0.0.5", publicIp: "203.0.113.10" });
    expect(result.orphans).toEqual([]);
});
