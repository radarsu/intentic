import { expect, test } from "vitest";
import { previewSubdomain, previewTarget } from "./preview-proxy.js";

const zone = "example.com";

test("previewSubdomain extracts the project from a single-label preview host", () => {
    expect(previewSubdomain("acme.preview.example.com", zone)).toBe("acme");
});

test("previewSubdomain rejects non-preview, empty, and dotted subdomains", () => {
    expect(previewSubdomain("app.example.com", zone)).toBeUndefined();
    expect(previewSubdomain("preview.example.com", zone)).toBeUndefined();
    expect(previewSubdomain("a.b.preview.example.com", zone)).toBeUndefined();
    expect(previewSubdomain("acme.preview.other.com", zone)).toBeUndefined();
});

test("previewTarget maps a preview host to the project's sandbox dev port", () => {
    expect(previewTarget("acme.preview.example.com", zone, 5173)).toBe("http://intentic-sandbox-acme:5173");
});

test("previewTarget is undefined for a host that is not a preview subdomain", () => {
    expect(previewTarget("app.example.com", zone, 5173)).toBeUndefined();
});
