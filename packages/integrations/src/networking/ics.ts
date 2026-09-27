export function icsEscape(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
export function icsTime(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
export function foldIcs(value: string) {
  let output = "",
    part = "";
  for (const character of value) {
    if (Buffer.byteLength(part + character, "utf8") > 73) {
      output += part + "\r\n ";
      part = "";
    }
    part += character;
  }
  return output + part;
}
export function icsDocument(lines: string[]): string {
  return lines.map(foldIcs).join("\r\n") + "\r\n";
}
