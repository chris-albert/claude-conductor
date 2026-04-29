import { useState, useEffect, useRef } from "react";
import {
  useSettings,
  updateSetting,
  resetSettings,
  settingDefaults,
} from "../lib/settings";
import type { Verbosity } from "../lib/settings";
import { DirTypeahead } from "./DirTypeahead";

interface SettingsModalProps {
  open: boolean;
  projectRoot: string;
  onClose: () => void;
}

type Tab = "general" | "theme";

const MODELS = [
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

export function SettingsModal({ open, onClose, projectRoot }: SettingsModalProps) {
  const settings = useSettings();
  const backdropRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("general");

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const isModified = Object.keys(settingDefaults).some(
    (k) =>
      settings[k as keyof typeof settings] !==
      settingDefaults[k as keyof typeof settingDefaults]
  );

  return (
    <div
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
    >
      <div className="w-[480px] max-h-[80vh] border border-c-border rounded-xl shadow-2xl overflow-hidden animate-slide-up" style={{ backgroundColor: "#1a1a24" }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-c-border">
          <h2 className="text-sm font-semibold text-c-text">Settings</h2>
          <button
            onClick={onClose}
            className="text-c-muted hover:text-c-text w-6 h-6 flex items-center justify-center rounded-md hover:bg-c-surface-active"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-c-border px-5">
          <TabButton active={tab === "general"} onClick={() => setTab("general")}>General</TabButton>
          <TabButton active={tab === "theme"} onClick={() => setTab("theme")}>Theme</TabButton>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5 overflow-y-auto max-h-[55vh]">
          {tab === "general" && (
            <>
              {/* Default model */}
              <SettingRow
                label="Default model"
                description="Model used for new sessions when the per-session dropdown is left on Default"
              >
                <div className="flex items-center gap-1">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => updateSetting("defaultModel", m.id)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                        settings.defaultModel === m.id
                          ? "bg-c-accent/15 text-c-accent border border-c-accent/30"
                          : "text-c-muted hover:text-c-text-secondary border border-c-border"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </SettingRow>

              {/* Default session folder */}
              <SettingRow
                label="Default session folder"
                description="Working directory used when creating new sessions. Leave empty to use the project root."
              >
                <DirTypeahead
                  value={settings.defaultSessionFolder}
                  onChange={(v) => updateSetting("defaultSessionFolder", v)}
                  placeholder={projectRoot || "/path/to/project"}
                  className="w-full text-xs font-mono bg-c-surface border border-c-border rounded-md px-2.5 py-1.5 text-c-text outline-none focus:border-c-accent/50 placeholder:text-c-muted/40"
                />
              </SettingRow>

              {/* Default verbosity */}
              <SettingRow
                label="Default tool verbosity"
                description="How much tool call detail to show in the session stream"
              >
                <div className="flex items-center gap-1">
                  {(["low", "med", "high"] as Verbosity[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => updateSetting("defaultVerbosity", v)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                        settings.defaultVerbosity === v
                          ? "bg-c-accent/15 text-c-accent border border-c-accent/30"
                          : "text-c-muted hover:text-c-text-secondary border border-c-border"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                  <span className="ml-2 text-2xs text-c-muted">
                    {settings.defaultVerbosity === "low" && "Messages only"}
                    {settings.defaultVerbosity === "med" && "Tool summaries"}
                    {settings.defaultVerbosity === "high" && "Full tool details"}
                  </span>
                </div>
              </SettingRow>
            </>
          )}

          {tab === "theme" && (
            <>
              {/* Editor Font Size */}
              <SettingRow
                label="Editor font size"
                description="Adjust the font size used in the code editor"
              >
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={10}
                    max={24}
                    step={1}
                    value={settings.editorFontSize}
                    onChange={(e) => updateSetting("editorFontSize", Number(e.target.value))}
                    className="flex-1 accent-c-accent h-1 cursor-pointer"
                  />
                  <span className="text-xs font-mono text-c-text w-8 text-right tabular-nums">
                    {settings.editorFontSize}px
                  </span>
                </div>
              </SettingRow>

              {/* Background Color */}
              <SettingRow
                label="Background color"
                description="Set the overall app background color"
              >
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={settings.backgroundColor}
                    onChange={(e) => updateSetting("backgroundColor", e.target.value)}
                    className="w-8 h-8 rounded-md border border-c-border cursor-pointer bg-transparent p-0.5"
                  />
                  <input
                    type="text"
                    value={settings.backgroundColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                        updateSetting("backgroundColor", v);
                      }
                    }}
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
                        updateSetting("backgroundColor", settings.backgroundColor);
                      }
                    }}
                    className="w-24 text-xs font-mono bg-c-surface border border-c-border rounded-md px-2 py-1.5 text-c-text outline-none focus:border-c-accent/50"
                  />
                </div>
              </SettingRow>

              {/* Background Image */}
              <SettingRow
                label="Background image"
                description="Set a full-screen background image"
              >
                <div className="flex items-center gap-3">
                  <label className="px-3 py-1.5 text-xs font-medium bg-c-surface hover:bg-c-surface-hover border border-c-border rounded-md cursor-pointer transition-colors text-c-text-secondary">
                    Choose image
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          updateSetting("backgroundImage", reader.result as string);
                        };
                        reader.readAsDataURL(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {settings.backgroundImage && (
                    <button
                      onClick={() => updateSetting("backgroundImage", "")}
                      className="px-3 py-1.5 text-xs text-c-muted hover:text-c-error border border-c-border rounded-md transition-colors"
                    >
                      Remove
                    </button>
                  )}
                  {settings.backgroundImage && (
                    <div
                      className="w-8 h-8 rounded-md border border-c-border bg-cover bg-center flex-shrink-0"
                      style={{ backgroundImage: `url(${settings.backgroundImage})` }}
                    />
                  )}
                </div>
              </SettingRow>

              {/* Background Image Opacity */}
              {settings.backgroundImage && (
                <SettingRow
                  label="Image opacity"
                  description="How much the background image shows through the UI"
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.backgroundImageOpacity}
                      onChange={(e) => updateSetting("backgroundImageOpacity", Number(e.target.value))}
                      className="flex-1 accent-c-accent h-1 cursor-pointer"
                    />
                    <span className="text-xs font-mono text-c-text w-10 text-right tabular-nums">
                      {Math.round(settings.backgroundImageOpacity * 100)}%
                    </span>
                  </div>
                </SettingRow>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-c-border flex items-center justify-between">
          <button
            onClick={resetSettings}
            className="text-2xs text-c-muted hover:text-c-text transition-colors"
          >
            Reset to defaults
          </button>
          <span className="text-2xs text-c-muted">
            {isModified ? "Modified" : "Default"}
          </span>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
        active
          ? "text-c-text-secondary border-c-accent"
          : "text-c-muted border-transparent hover:text-c-text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2">
        <span className="text-xs font-medium text-c-text">{label}</span>
        <p className="text-2xs text-c-muted mt-0.5">{description}</p>
      </div>
      {children}
    </div>
  );
}
