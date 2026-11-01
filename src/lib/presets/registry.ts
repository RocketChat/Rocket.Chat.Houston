/**
 * Leaf registry shared by the preset catalogue and the dynamic builders.
 *
 * The `Preset` shape itself lives in `./types`, which ranks below `lib/compose.ts` because
 * compose needs the shape.
 *
 * WHO IMPORTS THE BUILDERS IS DELIBERATE. The owners could register themselves on first
 * use, with this module importing each; here the LOADER imports them and this module only
 * checks that every builder arrived. A rank-2
 * registry reaching up to a rank-6 builder is the upward edge the layer gate exists to
 * forbid, and a dynamic `require()` would evade the gate rather than satisfy it. The
 * check with teeth -- "these names must be registered or nothing is returned" -- stays
 * here, where it was.
 */
import type { PortMap } from '../config';

import type { Preset } from './types';

/** `--set KEY=VALUE` params, as the raw strings they arrive as. */
export type Params = Record<string, unknown>;

/** `ports`: the workspace's side ports, sparse over the registry (`common.presetPorts`). */
export type Builder = (params: Params, ports: PortMap) => Preset;

export const REGISTRY: Record<string, Builder> = {};

/**
 * Registered scenario adapters, typed as `unknown`: naming the `Scenario` type here would
 * be a sideways edge between two rank-2 modules.
 */
export const SCENARIOS: Record<string, unknown> = {};

/**
 * The preset names the dynamic modules own.
 *
 * A registry that did the importing would keep module name -> preset name. The names are
 * what the check needs, so the names are what is kept.
 */
export const DYNAMIC_PRESETS: readonly string[] = Object.freeze([
  'e2ee',
  'email',
  'ldap',
  'livechat',
  'multi-instance',
  'oidc',
  's3_minio',
  'saml',
  'voice',
]);

/** Register the builder owned by a dynamic preset module. */
export function register(name: string, builder: Builder): void {
  if (name in REGISTRY) throw new Error(`preset builder '${name}' is already registered`);
  REGISTRY[name] = builder;
}

/** Register the scenario adapter owned by a dynamic preset module. */
export function registerScenario(name: string, scenario: unknown): void {
  if (name in SCENARIOS) throw new Error(`preset scenario '${name}' is already registered`);
  SCENARIOS[name] = scenario;
}

/** Every registered builder, once every owner has registered. */
export function builders(): Record<string, Builder> {
  const missing = DYNAMIC_PRESETS.filter((name) => !(name in REGISTRY));
  if (missing.length > 0) {
    throw new Error(`preset modules did not register builders: ${JSON.stringify(missing)}`);
  }
  return { ...REGISTRY };
}

/** Scenario adapters, after their owner modules have registered. */
export function scenarios(): Record<string, unknown> {
  builders();
  return { ...SCENARIOS };
}

/** Undo every registration -- the test seam that stands in for reloading this module. */
export function resetRegistry(): void {
  for (const key of Object.keys(REGISTRY)) delete REGISTRY[key];
  for (const key of Object.keys(SCENARIOS)) delete SCENARIOS[key];
}
