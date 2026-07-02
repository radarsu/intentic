import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Autostart wiring: write the OS-native "run at login, restart on crash" entry pointing at `intentic-sync run`.
// Boring per-OS file + one enable command each — no service-manager dependency. `command` is the fully-resolved
// argv (node + cli path + "run") so the entry doesn't depend on PATH resolution at boot.

const SERVICE = "intentic-sync";
const quote = (arg: string): string => (arg.includes(" ") ? `"${arg}"` : arg);

const systemdUnitPath = (): string => join(homedir(), ".config", "systemd", "user", `${SERVICE}.service`);
const launchdPlistPath = (): string => join(homedir(), "Library", "LaunchAgents", "dev.intentic.sync.plist");

const installLinux = async (command: readonly string[]): Promise<string> => {
    const path = systemdUnitPath();
    const unit = [
        "[Unit]",
        "Description=intentic-sync — mirror a sandbox to a local directory",
        "After=network-online.target",
        "",
        "[Service]",
        `ExecStart=${command.map(quote).join(" ")}`,
        "Restart=always",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
    await mkdir(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    await writeFile(path, unit, "utf8");
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const enabled = spawnSync("systemctl", ["--user", "enable", "--now", SERVICE], { stdio: "inherit" });
    // Linger keeps the user service running after logout / across reboots without an active session.
    spawnSync("loginctl", ["enable-linger"], { stdio: "ignore" });
    return enabled.status === 0 ? `enabled systemd user service (${path})` : `wrote ${path} — enable with: systemctl --user enable --now ${SERVICE}`;
};

const installMac = async (command: readonly string[]): Promise<string> => {
    const path = launchdPlistPath();
    const args = command.map((arg) => `        <string>${arg}</string>`).join("\n");
    const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "    <key>Label</key>",
        "    <string>dev.intentic.sync</string>",
        "    <key>ProgramArguments</key>",
        "    <array>",
        args,
        "    </array>",
        "    <key>RunAtLoad</key>",
        "    <true/>",
        "    <key>KeepAlive</key>",
        "    <true/>",
        "</dict>",
        "</plist>",
        "",
    ].join("\n");
    await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    await writeFile(path, plist, "utf8");
    spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
    spawnSync("launchctl", ["load", "-w", path], { stdio: "inherit" });
    return `loaded launchd agent (${path})`;
};

const installWindows = (command: readonly string[]): string => {
    const result = spawnSync("schtasks", ["/Create", "/TN", SERVICE, "/TR", command.map(quote).join(" "), "/SC", "ONLOGON", "/F"], { stdio: "inherit" });
    return result.status === 0 ? `registered scheduled task "${SERVICE}" (runs at logon)` : `failed to register scheduled task — run schtasks manually`;
};

export const install = async (command: readonly string[]): Promise<string> => {
    if (process.platform === "linux") {
        return installLinux(command);
    }
    if (process.platform === "darwin") {
        return installMac(command);
    }
    if (process.platform === "win32") {
        return installWindows(command);
    }
    throw new Error(`autostart is not supported on ${process.platform} — run \`intentic-sync run\` yourself.`);
};

export const uninstall = async (): Promise<string> => {
    if (process.platform === "linux") {
        spawnSync("systemctl", ["--user", "disable", "--now", SERVICE], { stdio: "ignore" });
        await rm(systemdUnitPath(), { force: true });
        return "removed systemd user service";
    }
    if (process.platform === "darwin") {
        spawnSync("launchctl", ["unload", launchdPlistPath()], { stdio: "ignore" });
        await rm(launchdPlistPath(), { force: true });
        return "removed launchd agent";
    }
    if (process.platform === "win32") {
        spawnSync("schtasks", ["/Delete", "/TN", SERVICE, "/F"], { stdio: "ignore" });
        return "removed scheduled task";
    }
    throw new Error(`autostart is not supported on ${process.platform}`);
};
