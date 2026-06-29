# Codex Switch for Windows

Electron-based Windows version of Codex Switch.

## Build

```powershell
cd CodexSwitchWin
npm install
npm run build
```

Build artifacts are written to:

```text
CodexSwitchWin\dist
```

## Runtime Data

Provider configuration and optional logs are stored in Electron's user data directory:

```text
%APPDATA%\Codex Switch
```

Persistent request/response logs are disabled by default.
