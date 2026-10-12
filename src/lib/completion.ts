import { listen } from "@tauri-apps/api/event";
import type { CompletionResult } from "../types";
import { requestCompletion } from "./shell";

interface CompletionPayload {
    tabId: string;
    reqId: string;
    result: CompletionResult | null;
}

const waiters = new Map<string, (r: CompletionResult | null) => void>();
let listening: Promise<unknown> | null = null;
let counter = 0;

function ensureListener() {
    listening ??= listen<CompletionPayload>("psoperator://completion", (e) => {
        const resolve = waiters.get(e.payload.reqId);
        if (resolve) {
            waiters.delete(e.payload.reqId);
            resolve(e.payload.result);
        }
    });
    return listening;
}

/**
 * Ask the tab's PowerShell for completions at `cursor`.
 * Resolves with null if PowerShell is busy, unreachable, or too slow.
 */
export async function complete(
    tabId: string,
    input: string,
    cursor: number,
    timeoutMs = 3000,
): Promise<CompletionResult | null> {
    await ensureListener();
    const reqId = `q${Date.now().toString(36)}${++counter}`;

    return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
            waiters.delete(reqId);
            resolve(null);
        }, timeoutMs);

        waiters.set(reqId, (r) => {
            window.clearTimeout(timer);
            resolve(r && Array.isArray(r.m) ? r : null);
        });

        requestCompletion(tabId, reqId, input, cursor).catch(() => {
            window.clearTimeout(timer);
            waiters.delete(reqId);
            resolve(null);
        });
    });
}