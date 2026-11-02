export interface Arguments {
  command: string;
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

export function parseArguments(argv: string[]): Arguments {
  const [command = "", ...tail] = argv;
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const value of tail) {
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const index = value.indexOf("=");
    if (index < 0) flags.add(value);
    else values.set(value.slice(0, index), value.slice(index + 1));
  }
  return { command, positional, flags, values };
}

export function requireKnownOptions(args: Arguments, flags: string[], values: string[]): void {
  const knownFlags = new Set(flags);
  const knownValues = new Set(values);
  for (const flag of args.flags) if (!knownFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
  for (const key of args.values.keys()) if (!knownValues.has(key)) throw new Error(`Unknown option: ${key}`);
}

export function requireNoPositionals(args: Arguments, command: string): void {
  if (args.positional.length) throw new Error(`${command} does not accept positional arguments`);
}

export function requirePositionalCount(args: Arguments, command: string, count: number): void {
  if (args.positional.length !== count) throw new Error(`Usage: migrator ${command} <name>`);
}

export function throughOption(args: Arguments): string | undefined {
  if (!args.values.has("--through")) return undefined;
  const through = args.values.get("--through") ?? "";
  if (!/^\d{4}$/.test(through)) throw new Error("Use --through=NNNN");
  return through;
}

export function applyDeferredOption(args: Arguments): string | undefined {
  if (!args.values.has("--apply-deferred")) return undefined;
  const value = args.values.get("--apply-deferred") ?? "";
  if (!/^\d{4}$/.test(value)) throw new Error("Use --apply-deferred=NNNN");
  return value;
}

/** `adopt [--apply]`: a dry run unless --apply; nothing else is accepted. */
export function adoptOptions(args: Arguments): { writeLedger: boolean } {
  requireNoPositionals(args, "adopt");
  requireKnownOptions(args, ["--apply"], []);
  return { writeLedger: args.flags.has("--apply") };
}
