import type { LocaleStrings } from "./zh-cn";

/**
 * English. Must mirror the structure of `zh-cn.ts` exactly —
 * `satisfies` turns any missing or misspelled key into a compile error.
 */
export const en = {
    plugin: {
        name: "OBSync",
        ribbonTooltip: "OBSync: sync vaults and install plugins",
        commandCategory: "OBSync",
    },

    common: {
        ok: "OK",
        cancel: "Cancel",
        save: "Save",
        close: "Close",
        delete: "Delete",
        edit: "Edit",
        retry: "Retry",
        copy: "Copy",
        copied: "Copied to clipboard",
        loading: "Loading…",
        none: "None",
        unknown: "Unknown",
        yes: "Yes",
        no: "No",
        confirm: "Confirm",
        enabled: "Enabled",
        disabled: "Disabled",
        version: "Version",
        actions: "Actions",
        refresh: "Refresh",
        optional: "Optional",
        required: "Required",
    },

    notice: {
        error: "Error",
        warning: "Warning",
        info: "Info",
        success: "Done",
    },

    host: {
        github: "GitHub",
        gitee: "Gitee",
        unknown: "Unknown host",
        detecting: "Detecting host…",
        tokenMissing: (host: string) =>
            `${host} requires an access token to read private repositories. Add one in settings.`,
        tokenInvalid: (host: string) => `The ${host} access token is invalid or expired.`,
        rateLimited: (host: string, resetAt: string) =>
            `${host} API rate limit reached. It resets at ${resetAt}.`,
        notFound: (host: string, repo: string) => `Repository ${repo} was not found on ${host}.`,
        networkFailed: (detail: string) => `Network request failed: ${detail}`,
        requestFailed: (status: number, detail: string) =>
            `Request failed (HTTP ${status}): ${detail}`,
        parseFailed: (input: string) =>
            `Could not parse the repository "${input}". Use owner/repo or a full repository URL.`,
        unsupportedHost: (input: string) =>
            `The host "${input}" is not supported yet. Only GitHub and Gitee are available.`,
    },

    settings: {
        title: "OBSync settings",

        language: {
            heading: "Language",
            name: "Interface language",
            desc: 'The language used by this plugin. "Follow Obsidian" uses the language you set in Obsidian.',
            auto: "Follow Obsidian",
        },

        token: {
            heading: "Access tokens",
            desc: "Needed for private repositories, and to raise the API rate limit. Tokens are stored on this device only — they are never written to data.json and never sync with your vault.",
            githubName: "GitHub access token",
            githubDesc: "Create one under Settings → Developer settings → Personal access tokens.",
            giteeName: "Gitee access token",
            giteeDesc: 'Create one under "Settings → Private tokens". The `projects` scope is required.',
            placeholder: "Paste a token…",
            test: "Test",
            testing: "Testing…",
            valid: (host: string, account: string) => `${host} token is valid. Account: ${account}`,
            invalid: (host: string) => `The ${host} token is invalid.`,
            cleared: "Token cleared",
        },

        general: {
            heading: "General",
            showNotices: "Show result notifications",
            showNoticesDesc: "When off, only errors are shown; success and progress notices are silenced.",
            debugLogging: "Verbose logging",
            debugLoggingDesc: "Log detailed request and sync information to the developer console.",
        },

        installer: {
            heading: "Plugin installer",
            enabled: "Enable plugin installer",
            enabledDesc: "Install and update community plugins from GitHub or Gitee.",
            autoCheck: "Check for updates on startup",
            autoCheckDesc: "Check tracked plugins for updates shortly after Obsidian starts.",
            autoCheckDelay: "Startup check delay (seconds)",
            autoCheckDelayDesc: "How long to wait before checking, so startup is not slowed down.",
            tracked: "Tracked plugins",
            trackedDesc: "Plugin repositories added or installed through OBSync.",
            trackedEmpty: "No plugin repositories added yet.",
            mirrorDiscovery: "Discover Gitee mirrors",
            mirrorDiscoveryDesc: "When installing a GitHub plugin, look for a same-named Gitee mirror first and download from it instead (faster in mainland China).",
        },

        sync: {
            heading: "Vault sync",
            enabled: "Enable vault sync",
            enabledDesc: "Sync this vault with system git. Desktop only.",
            desktopOnly: "Vault sync needs system git and is only available on desktop.",
            autoCommit: "Auto commit interval (minutes)",
            autoCommitDesc: "Set to 0 to disable.",
            autoPush: "Auto push interval (minutes)",
            autoPushDesc: "Set to 0 to disable.",
            autoPull: "Auto pull interval (minutes)",
            autoPullDesc: "Set to 0 to disable.",
            commitMessage: "Commit message template",
            commitMessageDesc: "Supports {{date}}, {{hostname}}, {{numFiles}} and {{files}}.",
        },
    },

    installer: {
        modalTitle: "Add plugin repository",
        repoLabel: "Repository",
        repoDesc: "Enter owner/repo, or paste a full GitHub / Gitee repository URL.",
        repoPlaceholder: "e.g. Dyse-Sofqi/OBSync or https://gitee.com/owner/repo",
        resolve: "Resolve",
        resolving: "Resolving…",
        resolved: (host: string, repo: string) => `Resolved to ${repo} on ${host}`,
        versionLabel: "Version to install",
        versionLatest: "Latest release",
        versionListFailed: "Could not fetch the version list; the latest version will be used.",
        enableAfterInstall: "Enable after installing",
        install: "Install",
        installing: "Installing…",
        installFailed: "Install failed",
        installed: (name: string, version: string) => `Installed ${name} ${version}`,
        updated: (name: string, version: string) => `Updated ${name} to ${version}`,
        upToDate: (name: string) => `${name} is already up to date`,
        reinstalled: (name: string) => `Reinstalled ${name}`,
        removed: (name: string) => `Removed ${name}`,
        removeFailed: "Removal failed",
        sourceRelease: "Source: release asset",
        sourceRaw: "Source: repository source file",
        mirrorFound: (repo: string) => `Found Gitee mirror ${repo}; downloading from it instead.`,
        noReleaseFallback: "This repository publishes no releases; installing from source files instead.",
        missingManifest: (repo: string) => `No valid manifest.json found in ${repo} — it may not be an Obsidian plugin repository.`,
        missingMainJs: (repo: string) => `No main.js found in ${repo}; cannot install.`,

        browse: "Browse community plugins",
        communitySearchPlaceholder: "Search by plugin name, author or description…",
        communityLoadFailed: "Could not load the community plugin list",

        checkOne: "Check for updates",
        checkAll: "Check all for updates",
        updateAll: "Update all plugins",
        updatedMany: (count: number, names: string) => `Updated ${count} plugin(s): ${names}`,
        updateFailedMany: (count: number) => `${count} plugin(s) failed to update`,
        checkFailed: "Update check failed",
        checking: "Checking for updates…",
        updateAvailable: (name: string, version: string) => `${name} has a newer version: ${version}.`,
        updatesAvailable: (count: number, names: string) =>
            `${count} plugin(s) can be updated: ${names}`,
        checkNone: "All plugins are up to date.",
        checkSummary: (outdated: number, failed: number) =>
            failed > 0
                ? `Check finished: ${outdated} update(s) available, ${failed} check(s) failed.`
                : `Check finished: ${outdated} update(s) available.`,
        updateToLatest: "Update to the latest version",
        reinstall: "Reinstall",
        freeze: "Freeze (exclude from automatic updates)",
        unfreeze: "Unfreeze",
        frozen: "Frozen",
        openRepo: "Open repository in browser",
        remove: "Remove",
        removeConfirm: (name: string) =>
            `Remove ${name}?\n\nThe plugin folder will be deleted, including any custom content inside it.`,
    },

    sync: {
        viewTitle: "OBSync",
        statusIdle: "Ready",
        statusPulling: "Pulling…",
        statusPushing: "Pushing…",
        statusCommitting: "Committing…",
        notARepo: "This vault is not a git repository yet.",
        gitNotFound: "Could not find the git executable. Set its path in settings.",
        nothingToCommit: "Nothing to commit.",
        conflictDetected: (count: number) =>
            `${count} conflicted file(s) detected. A conflict list has been written; resolve them and commit manually.`,
    },
} satisfies LocaleStrings;
