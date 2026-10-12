import { useEffect, useState } from "react";
import type { Settings } from "../types";
import { getSettings, setSettings } from "../lib/shell";

const SHELLS: { value: Settings["shell"]; label: string; note: string }[] = [
    { value: "auto", label: "Auto", note: "pwsh if installed, otherwise Windows PowerShell" },
    { value: "pwsh", label: "PowerShell 7", note: "pwsh.exe" },
    { value: "powershell", label: "Windows PowerShell", note: "powershell.exe (5.1)" },
];

export function SettingsDialog({ onClose, adminMode = false }: { onClose: () => void; adminMode?: boolean }) {
    const [draft, setDraft] = useState<Settings | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        getSettings()
            .then((settings) => setDraft({ ...settings, fontSize: settings.fontSize ?? 13.5, theme: settings.theme ?? "dark" }))
            .catch((e) => setError(String(e)));
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const save = async () => {
        if (!draft) return;
        try {
            await setSettings(draft);
            window.dispatchEvent(new CustomEvent("psoperator:appearance", { detail: { fontSize: draft.fontSize, theme: draft.theme } }));
            window.dispatchEvent(new CustomEvent("psoperator:settings", { detail: draft }));
            onClose();
        } catch (e) {
            setError(typeof e === "string" ? e : String(e));
        }
    };

    return (
        <div className="overlay" onMouseDown={onClose}>
            <div
                className="dialog"
                role="dialog"
                aria-label="Settings"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="dialog-title">
                    <span className="glyph">✻</span> Settings
                </div>

                {draft ? (
                    <>
                        <fieldset>
                            <legend>Shell</legend>
                            {SHELLS.map((s) => (
                                <label key={s.value} className="choice">
                                    <input
                                        type="radio"
                                        name="shell"
                                        checked={draft.shell === s.value}
                                        onChange={() => setDraft({ ...draft, shell: s.value })}
                                    />
                                    <span>{s.label}</span>
                                    <span className="dim">{s.note}</span>
                                </label>
                            ))}
                        </fieldset>

                        <fieldset>
                            <legend>Appearance</legend>
                            <label className="setting-row">
                                <span>Terminal font size</span>
                                <input aria-label="Terminal font size" type="range" min="11" max="20" step="0.5" value={draft.fontSize}
                                    onChange={(e) => setDraft({ ...draft, fontSize: Number(e.target.value) })} />
                                <span className="setting-value">{draft.fontSize}px</span>
                            </label>
                            <label className="setting-row">
                                <span>Color theme</span>
                                <select value={draft.theme} disabled={adminMode} onChange={(e) => setDraft({ ...draft, theme: e.target.value as Settings["theme"] })}>
                                    <option value="dark">Warm dark</option>
                                    <option value="light">Light</option>
                                    <option value="midnight">Midnight</option>
                                    <option value="cyberpunk">Cyberpunk</option>
                                    <option value="matcha">Matcha</option>
                                    <option value="nord">Nord</option>
                                </select>
                            </label>
                        </fieldset>

                        <fieldset>
                            <legend>Profile</legend>
                            <label className="choice">
                                <input
                                    type="checkbox"
                                    checked={draft.loadProfile}
                                    onChange={(e) => setDraft({ ...draft, loadProfile: e.target.checked })}
                                />
                                <span>Load my PowerShell profile</span>
                                <span className="dim">runs $PROFILE when a session starts</span>
                            </label>
                        </fieldset>

                        <fieldset>
                            <legend>Process panes</legend>
                            <label className="choice">
                                <input type="radio" name="splitMode" checked={draft.splitMode === "manual"}
                                    onChange={() => setDraft({ ...draft, splitMode: "manual" })} />
                                <span>Manual</span>
                                <span className="dim">Choose when a detected process opens in its own pane</span>
                            </label>
                            {adminMode && <p className="dim">Administrator windows always use the very dark theme.</p>}
                            <label className="choice">
                                <input type="radio" name="splitMode" checked={draft.splitMode === "automatic"}
                                    onChange={() => setDraft({ ...draft, splitMode: "automatic" })} />
                                <span>Automatic</span>
                                <span className="dim">Open detected processes in a separate pane automatically</span>
                            </label>
                        </fieldset>

                        <p className="dim dialog-note">
                            Changes apply to new tabs and after /restart. Profile output is hidden, and prompt
                            themes have no effect in PSOperator.
                        </p>
                    </>
                ) : (
                    !error && <p className="dim">Loading…</p>
                )}

                {error && <p className="dialog-error">{error}</p>}

                <div className="dialog-actions">
                    <button className="btn" onClick={onClose}>
                        Cancel
                    </button>
                    <button className="btn primary" onClick={() => void save()} disabled={!draft}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
