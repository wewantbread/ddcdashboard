import { spawnSync } from "node:child_process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getWindowsPowerShellExePath, getWindowsWmicExePath } from "./windows-install-roots.js";

function parseWindowsProcessStartTime(raw: Buffer | string): number | null {
  const output = Buffer.isBuffer(raw)
    ? raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe
      ? raw.toString("utf16le")
      : raw.toString("utf8")
    : raw;
  const lines = normalizeStringEntries(output.split(/\r?\n/));
  const value =
    lines
      .find((line) => normalizeLowercaseStringOrEmpty(line).startsWith("creationdate="))
      ?.slice("creationdate=".length)
      .trim() ??
    lines.find((line) => normalizeLowercaseStringOrEmpty(line) !== "creationdate") ??
    "";
  const parsedIso = Date.parse(value);
  if (Number.isFinite(parsedIso)) {
    return parsedIso;
  }
  const dmtf = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/);
  if (!dmtf) {
    return null;
  }
  const [, year, month, day, hour, minute, second, microseconds, offsetSign, offset] = dmtf;
  const localTimeMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Math.floor(Number(microseconds) / 1000),
  );
  return localTimeMs - Number(offset) * 60_000 * (offsetSign === "+" ? 1 : -1);
}

export function readWindowsProcessStartTimeSync(pid: number, timeoutMs = 5_000): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const powershell = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; [Console]::Out.Write($process.CreationDate.ToUniversalTime().ToString("o"))`,
    ],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
  );
  if (!powershell.error && powershell.status === 0) {
    const startTime = parseWindowsProcessStartTime(powershell.stdout);
    if (startTime !== null) {
      return startTime;
    }
  }
  const wmic = spawnSync(
    getWindowsWmicExePath(),
    ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
    {
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return !wmic.error && wmic.status === 0 ? parseWindowsProcessStartTime(wmic.stdout) : null;
}
