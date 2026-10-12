import type { Settings } from "../types";
import { getSettings } from "./shell";

export type SfxName = "typing" | "error" | "output" | "input";

const soundFiles: Record<SfxName, string> = {
  typing: "/sounds/typing.mp3",
  error: "/sounds/error.mp3",
  output: "/sounds/output.mp3",
  input: "/sounds/input.mp3",
};

let volume = 0;
let loaded = false;
let lastTypingAt = 0;
const players = new Map<SfxName, HTMLAudioElement>();

export function setSfxVolume(value: number) {
  volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  loaded = true;
}

export async function loadSfxPreference(settings?: Settings) {
  try {
    const current = settings ?? await getSettings();
    setSfxVolume(current.sfxVolume);
  } catch {
    setSfxVolume(0);
  }
}

export function playSfx(name: SfxName) {
  if (!loaded || volume <= 0) return;
  if (name === "typing") {
    const now = performance.now();
    if (now - lastTypingAt < 45) return;
    lastTypingAt = now;
  }

  try {
    let player = players.get(name);
    if (!player) {
      player = new Audio(soundFiles[name]);
      player.preload = "auto";
      players.set(name, player);
    }
    player.volume = volume;
    player.currentTime = 0;
    void player.play().catch(() => {
      // Audio may be unavailable until the user interacts with the window.
    });
  } catch {
    // Audio is an optional enhancement; keep the terminal usable if unavailable.
  }
}
