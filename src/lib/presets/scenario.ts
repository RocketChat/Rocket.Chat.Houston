/**
 * Internal contract for built-in reproduction scenarios.
 *
 * The public aggregate remains `Preset`. A scenario owns only the deployment-neutral intent
 * and its parameter contract; each adapter turns that intent into the native fields one
 * supported deployment type needs. There is deliberately no plugin loading and no public CLI
 * surface here.
 */
import type { PortMap } from '../config';

import type { Params } from './registry';
import type { Preset } from './types';

export interface ScenarioSpec<Intent> {
  readonly name: string;
  readonly paramsHelp: Readonly<Record<string, string>>;
  /** Earlier spellings of `paramsHelp` keys, old → now (2.1.3's `sip` for `sip_integration`). */
  readonly paramAliases?: Readonly<Record<string, string>>;
  readonly resolveIntent: (params: Params) => Intent;
  readonly adapters: Readonly<Record<string, (intent: Intent, ports: PortMap) => Preset>>;
}

/**
 * `params` with each alias key moved to the key it stands for. Both spellings of one option in
 * one request is a refusal, never a silent winner.
 */
export function canonicalParams(params: Params, aliases: Readonly<Record<string, string>>): Params {
  const out: Params = { ...params };
  for (const [old, now] of Object.entries(aliases)) {
    if (!Object.hasOwn(out, old)) continue;
    if (Object.hasOwn(out, now)) {
      throw new Error(`--set ${old} is the earlier spelling of ${now}; give one of them`);
    }
    out[now] = out[old];
    delete out[old];
  }
  return out;
}

/** One built-in scenario and its small deployment-specific adapters. */
export class Scenario<Intent = unknown> {
  readonly name: string;
  readonly paramsHelp: Readonly<Record<string, string>>;
  readonly paramAliases: Readonly<Record<string, string>>;
  readonly resolveIntent: (params: Params) => Intent;
  readonly adapters: Readonly<Record<string, (intent: Intent, ports: PortMap) => Preset>>;

  constructor(spec: ScenarioSpec<Intent>) {
    this.name = spec.name;
    this.paramsHelp = spec.paramsHelp;
    this.paramAliases = spec.paramAliases ?? {};
    this.resolveIntent = spec.resolveIntent;
    this.adapters = spec.adapters;
  }

  /** `ports`: the workspace's side ports, sparse; `{}` is every preferred one. */
  resolve(params: Params | null | undefined, deploymentType: string, ports: PortMap = {}): Preset {
    const given = canonicalParams(params ?? {}, this.paramAliases);
    const known = new Set(Object.keys(this.paramsHelp));
    const unknown = Object.keys(given)
      .filter((key) => !known.has(key))
      .sort();
    if (unknown.length > 0) {
      const valid =
        Object.keys(this.paramsHelp).sort().join(', ') || '(this preset takes no --set params)';
      throw new Error(
        `unknown --set param(s) for preset '${this.name}': ${unknown.join(', ')} - valid: ${valid}`,
      );
    }
    const adapter = this.adapters[deploymentType];
    if (adapter === undefined) {
      const supported = Object.keys(this.adapters).sort().join(', ') || 'none';
      throw new Error(
        `preset '${this.name}' does not support deployment type ` +
          `'${deploymentType}'; supported: ${supported}`,
      );
    }
    return { ...adapter(this.resolveIntent(given), ports), paramAliases: { ...this.paramAliases } };
  }
}
