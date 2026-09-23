import type { Tenant } from "@aomi-telegram/core";
import { world } from "@aomi-telegram/tenant-world";

export const tenants: ReadonlyMap<string, Tenant<any>> = new Map([[world.id, world]]);
