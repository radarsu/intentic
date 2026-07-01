import { describe, expect, it } from "vitest";
import { neutralConfig, selfHostConfig } from "./init.js";

describe("selfHostConfig", () => {
    it("targets the self host with the app.<zone> domain", () => {
        const config = selfHostConfig("example.com");
        expect(config).toContain("on: self,");
        expect(config).toContain(`domain: "app.example.com"`);
        // Keeps the Cloudflare resource (apply needs it to stand up the tunnel) but drops the placeholder host.
        expect(config).toContain(`i.have.cloudflare("cf"`);
        expect(config).not.toContain("203.0.113.10");
        expect(config).not.toContain(`i.have.host(`);
        // The zero-dependency starter app needs no database — keep the scaffold provisionable without extra secrets.
        expect(config).not.toContain("PRODUCTION_DATABASE_URL");
    });

    it("falls back to the placeholder domain when the zone is unknown", () => {
        expect(selfHostConfig(undefined)).toContain(`domain: "app.example.com"`);
    });
});

describe("neutralConfig", () => {
    it("emits an empty managed region with no host and no app", () => {
        const config = neutralConfig();
        expect(config).toContain("// <intentic> managed");
        expect(config).toContain("// </intentic>");
        expect(config).toContain("defineIntent");
        // Keeps both imports so the file stays valid the moment /inventory inserts an env()-bearing backend.
        expect(config).toContain(`import { env } from "@intentic/graph"`);
        expect(config).not.toContain("i.have.host(");
        expect(config).not.toContain("i.want.app(");
        expect(config).not.toContain("203.0.113.10");
        expect(config).not.toContain("on: self");
    });
});
