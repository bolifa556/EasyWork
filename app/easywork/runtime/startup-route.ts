export function startupDestination(pathname: string, search: string, firstDeviceVisit: boolean, automaticHelp: boolean) {
  if (firstDeviceVisit) return "/help";
  if (automaticHelp && pathname === "/help") return "/";
  return pathname + search;
}
