export function redactCredentials(message: string): string {
  return message
    .replace(/\b(postgres(?:ql)?:\/\/)[^/?#\s]+@/gi, "$1[redacted]@")
    .replace(/(password\s*[=:]\s*)[^&\s,;]+/gi, "$1[redacted]");
}
