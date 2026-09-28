/** Shared byte formatting only; each calendar builder owns its content and METHOD. */
export const escapeIcs = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
export const dateIcs = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
export function foldIcs(line: string) {
  let output = "",
    part = "";
  for (const character of line) {
    if (Buffer.byteLength(part + character) > 73) {
      output += part + "\r\n ";
      part = "";
    }
    part += character;
  }
  return output + part;
}
