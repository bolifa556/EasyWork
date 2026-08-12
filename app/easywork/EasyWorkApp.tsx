"use client";

import { AppRuntimeProvider } from "./runtime/AppRuntime";
import { AppShell } from "./shell/AppShell";

export default function EasyWorkApp() {
  return <AppRuntimeProvider><AppShell /></AppRuntimeProvider>;
}
