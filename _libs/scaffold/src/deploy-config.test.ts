import type { InventoryEntry } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { readManagedRegion, scaffoldDeployConfig, writeManagedRegion } from "./deploy-config.js";

const hostEntry: InventoryEntry = { kind: "backend", provider: "host", name: "self", values: { address: "1.2.3.4", user: "deploy", port: 22 } };
const cfEntry: InventoryEntry = { kind: "backend", provider: "cloudflare", name: "cf", values: {} };
const signozEntry: InventoryEntry = {
    kind: "service",
    service: "signoz",
    name: "obs",
    on: "self",
    expose: "cf",
    values: { domain: "signoz.example.com" },
};

describe("deploy-config managed region", () => {
    test("a scaffold has an empty managed region", () => {
        expect(readManagedRegion(scaffoldDeployConfig([]))).toEqual([]);
    });

    test("the neutral scaffold declares no host and no app", () => {
        const src = scaffoldDeployConfig([]);
        expect(src).toContain("// <intentic> managed");
        expect(src).toContain("defineIntent");
        // Keeps both imports so the file stays valid the moment /inventory inserts an env()-bearing backend.
        expect(src).toContain(`import { env } from "@intentic/graph"`);
        expect(src).not.toContain("i.have.host(");
        expect(src).not.toContain("i.want.app(");
        expect(src).not.toContain("203.0.113.10");
        expect(src).not.toContain("on: self");
    });

    test("round-trips a backend entry, dropping its secret (env) fields from the parsed values", () => {
        const src = scaffoldDeployConfig([hostEntry]);
        // The rendered host carries sshKey: env("HOST_SSH_KEY"); the parser surfaces only the non-secret scalars.
        expect(src).toContain(`sshKey: env("HOST_SSH_KEY")`);
        expect(readManagedRegion(src)).toEqual([
            { kind: "backend", provider: "host", name: "self", values: { address: "1.2.3.4", user: "deploy", port: 22 } },
        ]);
    });

    test("round-trips a service losslessly (on/expose stay bare-name refs, domain stays a value)", () => {
        const src = scaffoldDeployConfig([signozEntry]);
        expect(src).toContain(`on: self`);
        expect(src).toContain(`expose: cf`);
        expect(readManagedRegion(src)).toEqual([signozEntry]);
    });

    test("writeManagedRegion replaces the region in place and is stable across repeated writes", () => {
        const once = writeManagedRegion(scaffoldDeployConfig([]), [hostEntry, cfEntry, signozEntry]);
        const twice = writeManagedRegion(once, readManagedRegion(once));
        expect(twice).toBe(once);
        expect(readManagedRegion(twice)).toEqual([hostEntry, cfEntry, signozEntry]);
    });

    test("preserves user code outside the managed markers", () => {
        const src = [
            `import { env } from "@intentic/graph";`,
            `import { defineIntent } from "@intentic/sdk";`,
            ``,
            `export const intent = defineIntent((i) => {`,
            `    // <intentic> managed — do not edit by hand`,
            `    const self = i.have.host("self", { address: "1.2.3.4", user: "deploy", port: 22, sshKey: env("HOST_SSH_KEY") });`,
            `    // </intentic>`,
            `    i.want.app("web", { on: self, expose: cf, environments: {} });`,
            `});`,
            ``,
        ].join(`\n`);
        const rewritten = writeManagedRegion(src, []);
        expect(rewritten).toContain(`i.want.app("web"`);
        expect(readManagedRegion(rewritten)).toEqual([]);
    });

    test("skips declarations for providers it does not model", () => {
        const src = scaffoldDeployConfig([]).replace(`// </intentic>`, `    const x = i.have.mystery("x", { foo: "bar" });\n    // </intentic>`);
        expect(readManagedRegion(src)).toEqual([]);
    });
});
