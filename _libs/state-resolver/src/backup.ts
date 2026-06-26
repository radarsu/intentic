import type { BackupInput, HostInput } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { backupId, forgejoId, komodoId } from "./ids.js";
import { IMAGES } from "./images.js";

// The scheduled restic backup for a host: one container that, on the declared cron, takes app-consistent
// dumps of Forgejo + Komodo (and SignOz when opted in) and pushes them to the operator's restic repo. It is
// deployed onto the host over SSH like the platform services, and depends on the control-plane nodes it
// dumps so the job is installed only once they exist. `signoz` is honoured only when a SignOz service is
// actually declared (nothing to back up otherwise). Secrets (repo password + backend credentials) are
// SecretRefs that serialize as $secret inputs, so collectSecrets carries them into .env.example / adopt.
export const resolveBackup = (hostId: string, host: HostInput, input: BackupInput, signozServiceId: string | undefined): ResolvedNode => {
    const ssh = {
        address: host.address,
        user: host.user,
        sshKey: host.sshKey,
        ...(host.port !== undefined ? { port: host.port } : {}),
    };
    const signoz = input.signoz === true && signozServiceId !== undefined;
    return {
        id: backupId(hostId),
        type: "backup",
        inputs: {
            ...ssh,
            repo: input.repo,
            password: input.password,
            signoz,
            image: IMAGES.backup,
            ...(input.credentials !== undefined ? { credentials: input.credentials } : {}),
            ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
            ...(input.retention !== undefined ? { retention: input.retention } : {}),
        },
        explicitDependsOn: [forgejoId(hostId), komodoId(hostId), ...(signoz ? [signozServiceId] : [])],
    };
};
