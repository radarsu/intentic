import { expect, test } from "vitest";
import { REPO_ROLES, workspacePaths } from "./workspace.js";

test("workspacePaths lays each repo out under <root>/<role>", () => {
    const paths = workspacePaths("/work");
    expect(paths.root).toBe("/work");
    expect(paths.repos).toEqual({ intent: "/work/intent", "desired-state": "/work/desired-state", app: "/work/app" });
});

test("every declared repo role has a derived path", () => {
    const paths = workspacePaths("/work");
    for (const role of REPO_ROLES) {
        expect(typeof paths.repos[role]).toBe("string");
    }
});
