export function resolveAutomationNow(rawValue) {
  if (!rawValue) return new Date();
  const value = new Date(rawValue);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid EA_NOW_ISO value: ${rawValue}`);
  }
  return value;
}

export function resolveAutomationNowIso(rawValue = process.env.EA_NOW_ISO) {
  return resolveAutomationNow(rawValue).toISOString();
}
