import { readFile, writeFile } from "node:fs/promises";
import type { DesiredStateGraph } from "@intentic/graph";

// The file a user authors (intent), the artifact `resolve` writes, and the execution record `apply` writes
// beside it. The two repos a local control plane is made of hold these.
export const CONFIG_FILE = "deploy.config.ts";
export const ARTIFACT_FILE = "reconciliation-target.json";
export const STATUS_FILE = "status.json";

export const readArtifact = async (path: string): Promise<DesiredStateGraph> => {
    const graph = JSON.parse(await readFile(path, "utf8")) as DesiredStateGraph;
    if (graph.version !== 1) {
        throw new Error(`${path} is not a reconciliation-target artifact (expected version 1)`);
    }
    return graph;
};

export const writeArtifact = async (path: string, graph: DesiredStateGraph): Promise<void> =>
    writeFile(path, `${JSON.stringify(graph, undefined, 4)}\n`);

export const writeStatus = async (path: string, status: unknown): Promise<void> => writeFile(path, `${JSON.stringify(status, undefined, 4)}\n`);
