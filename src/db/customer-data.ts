export function normalizeCustomerEmail(rawEmail: string): string {
  const normalized = rawEmail.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error("Email cannot be normalized safely");
  }
  return normalized;
}
