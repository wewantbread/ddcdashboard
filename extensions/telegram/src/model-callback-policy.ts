import {
  findCommandByNativeName,
  resolveCommandArgMenu,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function isTelegramRoutedModelSelectionAllowed(params: {
  cfg: OpenClawConfig;
  agentId: string;
  selectedModelRef: string;
  configuredDefaultRef: string;
}): boolean {
  if (params.selectedModelRef === params.configuredDefaultRef) {
    return true;
  }
  const command = findCommandByNativeName("model", "telegram");
  const choices = command
    ? resolveCommandArgMenu({ command, cfg: params.cfg, agentId: params.agentId })?.choices
    : undefined;
  return choices?.some((choice) => choice.value === params.selectedModelRef) === true;
}
