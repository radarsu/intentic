import { env } from "@intentic/graph";
import { expect, test } from "vitest";
import { enumerateAssignments, generateCandidates } from "./candidate.js";
import type { Catalog, Option } from "./catalog.js";
import { defaultCatalog } from "./catalog.js";
import type { IntentSet } from "./intent.js";

const cloud = { id: "cf", input: { accountId: "a", apiToken: env("T"), zone: "example.com" } };
const host = { id: "host", input: { address: "1.2.3.4", user: "deploy", sshKey: env("K") } };

const intent: IntentSet = {
    hosts: [host],
    clouds: [cloud],
    apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
};

test("the default catalog yields exactly one candidate built from forgejo/komodo/ssh-linux/cloudflare-tunnel", () => {
    const candidates = generateCandidates(intent);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.key).toBe("cloudflare-tunnel+forgejo+komodo+ssh-linux");
    expect(candidates[0]?.chosenOptions["source-control:host"]).toBe("forgejo");
    expect(candidates[0]?.chosenOptions["docker-registry:host"]).toBe("forgejo");
    expect(Object.keys(candidates[0]?.graph.resources ?? {})).toContain("host-git");
});

test("a second source-control+registry option yields two assignments and filters the split combo", () => {
    const gitlab: Option = { id: "gitlab", provides: ["source-control", "docker-registry"] };
    const withGitlab: Catalog = {
        optionsFor: (capability) =>
            capability === "source-control" || capability === "docker-registry"
                ? [...defaultCatalog.optionsFor(capability), gitlab]
                : defaultCatalog.optionsFor(capability),
    };

    const plans = enumerateAssignments(intent, withGitlab);
    // forgejo-for-both and gitlab-for-both are valid; the forgejo/gitlab split is filtered out.
    expect(plans.map((plan) => plan.key).sort()).toEqual(["cloudflare-tunnel+forgejo+komodo+ssh-linux", "cloudflare-tunnel+gitlab+komodo+ssh-linux"]);
    for (const plan of plans) {
        expect(plan.chosenOptions["source-control:host"]).toBe(plan.chosenOptions["docker-registry:host"]);
    }
});

test("a need with no option throws", () => {
    const empty: Catalog = { optionsFor: (capability) => (capability === "infra-control" ? [] : defaultCatalog.optionsFor(capability)) };
    expect(() => enumerateAssignments(intent, empty)).toThrow('no option satisfies "infra-control"');
});
