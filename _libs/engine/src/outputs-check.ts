import type { ResourceType } from "@intentic/resolvers";
import { OUTPUTS } from "@intentic/resolvers";

// A provider may only produce outputs declared for its kind in the OUTPUTS authority. (It need not
// produce all of them; a missing output that something REFERENCES is caught later at ref resolution.)
export const validateOutputs = (type: ResourceType, produced: Readonly<Record<string, unknown>>, id: string): void => {
    const allowed = OUTPUTS[type];
    for (const name of Object.keys(produced)) {
        if (!allowed.includes(name)) {
            throw new Error(`provider for "${id}" (type "${type}") produced unknown output "${name}"; allowed: [${allowed.join(", ")}]`);
        }
    }
};
