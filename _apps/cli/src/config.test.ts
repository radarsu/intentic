import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "./config.js";

const setEnv = (vars: Readonly<Record<string, string>>): void => {
    for (const [key, value] of Object.entries(vars)) {
        vi.stubEnv(key, value);
    }
};

const fullEnv = {
    INTENTIC_HOST_ADDRESS: "10.0.0.1",
    INTENTIC_HOST_USER: "deploy",
    INTENTIC_CONTROL_INTERNAL_IP: "10.0.0.2",
    INTENTIC_CONTROL_DOMAIN: "git.example.com",
};

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("readConfig", () => {
    it("sources config from env when no flags are given", () => {
        setEnv(fullEnv);
        const config = readConfig({});
        expect(config.host.address).toBe("10.0.0.1");
        expect(config.host.user).toBe("deploy");
        expect(config.internalIp).toBe("10.0.0.2");
        expect(config.domain).toBe("git.example.com");
        expect(config.host.port).toBeUndefined();
    });

    it("prefers flags over env", () => {
        setEnv(fullEnv);
        const config = readConfig({ hostAddress: "flag-addr", domain: "flag.example.com" });
        expect(config.host.address).toBe("flag-addr");
        expect(config.domain).toBe("flag.example.com");
        expect(config.host.user).toBe("deploy");
    });

    it("throws when neither flag nor env provides a required value", () => {
        setEnv({ ...fullEnv, INTENTIC_HOST_ADDRESS: "" });
        expect(() => readConfig({})).toThrow(/host-address/);
    });

    it("parses the host port as a number from flag and from env", () => {
        setEnv(fullEnv);
        expect(readConfig({ hostPort: 2222 }).host.port).toBe(2222);
        vi.stubEnv("INTENTIC_HOST_PORT", "2200");
        expect(readConfig({}).host.port).toBe(2200);
    });

    it("keeps secrets as env references, never reading their values", () => {
        setEnv(fullEnv);
        const config = readConfig({});
        expect(config.host.sshKey.key).toBe("HOST_SSH_KEY");
        expect(config.adminPassword.key).toBe("FORGEJO_ADMIN_PASSWORD");
    });
});
