/** Minimal CLI parser; accepts --name=value and --json (no new packages). */
export function argsToObject(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`Expected --name=value: ${arg}`);
    const equals = arg.indexOf('=');
    const key = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
    if (!key || key in args) throw new Error(`Duplicate or empty option: ${key}`);
    args[key] = equals < 0 ? 'true' : arg.slice(equals + 1);
  }
  return args;
}
export function optionalInteger(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`Invalid integer: ${text}`);
  return Number(text);
}
export function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}
