import { expect, test } from "vitest";
import { type DockerRunner, ensureNetwork, inspectContainer, removeContainer, runContainer } from "./docker.js";

// A DockerRunner that returns a canned result per joined-args key (default success) and records every call.
const recordingDocker = (responses: Readonly<Record<string, { stdout?: string; code: number }>> = {}) => {
    const calls: string[][] = [];
    const docker: DockerRunner = async (args) => {
        calls.push([...args]);
        const response = responses[args.join(" ")];
        return { stdout: response?.stdout ?? "", stderr: "", code: response?.code ?? 0 };
    };
    return { docker, calls };
};

test("inspectContainer reports running state and image", async () => {
    const { docker } = recordingDocker({
        "inspect --format {{.State.Running}} {{.Config.Image}} c": { stdout: "true intentic/sandbox:1\n", code: 0 },
    });
    expect(await inspectContainer("c", docker)).toEqual({ running: true, image: "intentic/sandbox:1" });
});

test("inspectContainer treats an absent container as not running", async () => {
    const { docker } = recordingDocker({ "inspect --format {{.State.Running}} {{.Config.Image}} c": { code: 1 } });
    expect(await inspectContainer("c", docker)).toEqual({ running: false });
});

test("runContainer builds the run argv with network, env, volumes, and labels", async () => {
    const { docker, calls } = recordingDocker();
    await runContainer(
        {
            name: "box",
            image: "intentic/sandbox:1",
            network: "intentic-workspace",
            env: { A: "1" },
            volumes: ["vol:/work"],
            labels: { "intentic.project": "acme" },
        },
        docker,
    );
    expect(calls[0]).toEqual([
        "run",
        "-d",
        "--restart",
        "unless-stopped",
        "--name",
        "box",
        "--network",
        "intentic-workspace",
        "-e",
        "A=1",
        "-v",
        "vol:/work",
        "--label",
        "intentic.project=acme",
        "intentic/sandbox:1",
    ]);
});

test("runContainer throws on a non-zero exit", async () => {
    const failing: DockerRunner = async () => ({ stdout: "", stderr: "boom", code: 125 });
    await expect(runContainer({ name: "box", image: "img" }, failing)).rejects.toThrow("docker run box failed");
});

test("removeContainer always rm -f (idempotent)", async () => {
    const { docker, calls } = recordingDocker();
    await removeContainer("box", docker);
    expect(calls).toEqual([["rm", "-f", "box"]]);
});

test("ensureNetwork creates the network only when missing", async () => {
    const present = recordingDocker({ "network inspect intentic-workspace": { code: 0 } });
    await ensureNetwork("intentic-workspace", present.docker);
    expect(present.calls).toEqual([["network", "inspect", "intentic-workspace"]]);

    const missing = recordingDocker({ "network inspect intentic-workspace": { code: 1 } });
    await ensureNetwork("intentic-workspace", missing.docker);
    expect(missing.calls).toContainEqual(["network", "create", "intentic-workspace"]);
});
