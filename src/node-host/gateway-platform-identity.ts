import {
  resolveGatewayClientDeviceFamily,
  resolveGatewayClientPlatform,
} from "../shared/gateway-client-platform.js";

export function resolveNodeHostGatewayPlatformIdentity(platform: NodeJS.Platform): {
  platform: string;
  deviceFamily?: string;
} {
  const deviceFamily = resolveGatewayClientDeviceFamily(platform);
  return {
    platform: resolveGatewayClientPlatform(platform),
    ...(deviceFamily ? { deviceFamily } : {}),
  };
}
