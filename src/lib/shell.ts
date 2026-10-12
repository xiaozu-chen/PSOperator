import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SessionInfo, Settings } from "../types";

export const startShell = (tabId: string, cwd?: string) =>
  invoke<SessionInfo>("start_shell", { tabId, cwd });
export const getSessionInfo = (tabId: string) =>
  invoke<SessionInfo>("get_session_info", { tabId });
export const openLocalUrl = (url: string) => openUrl(url);
export const closeTab = (tabId: string) => invoke<void>("close_tab", { tabId });
export const runCommand = (tabId: string, id: string, command: string) =>
  invoke<void>("run_command", { tabId, id, command });
export const sendInput = (tabId: string, text: string) =>
  invoke<void>("send_input", { tabId, text });
export const cancelCommand = (tabId: string) => invoke<void>("cancel_command", { tabId });
export const restartShell = (tabId: string) => invoke<void>("restart_shell", { tabId });
export const requestCompletion = (tabId: string, reqId: string, input: string, cursor: number) =>
  invoke<void>("request_completion", { tabId, reqId, input, cursor });
export const completePath = (tabId: string, partial: string) =>
  invoke<string[]>("complete_path", { tabId, partial });
export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) =>
  invoke<Settings>("set_settings", { settings });
export const isAdminMode = () => invoke<boolean>("is_admin_mode");
export const launchAdmin = (tabId: string) => invoke<void>("launch_admin", { tabId });
export interface DirectoryTreeNode {
  id: number;
  parentId: number | null;
  name: string;
  path: string;
  isDirectory: boolean;
  depth: number;
  size: number | null;
}
export interface DirectoryTree {
  root: string;
  nodes: DirectoryTreeNode[];
  truncated: boolean;
}
export const readDirectoryTree = (path: string) =>
  invoke<DirectoryTree>("read_directory_tree", { path });
