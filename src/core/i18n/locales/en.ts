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
        cmdOpenSettings: "OBSync: Open settings",

        tabs: {
            tracked: "Tracked plugins",
            installer: "Plugin installer",
            sync: "Vault sync",
            general: "General",
        },
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
            configured: "Configured",
            notConfigured: "Not set",
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
            autoCheckDesc: "Check tracked plugins for updates shortly after Obsidian starts. Off by default — the check on opening this settings tab covers most cases.",
            autoCheckDelay: "Startup check delay (seconds)",
            autoCheckDelayDesc: "How long to wait before checking, so startup is not slowed down.",
            autoCheckOnSettingsOpen: "Check when opening settings",
            autoCheckOnSettingsOpenDesc: "Run an update check when this settings page opens. Repeated openings within a short window are skipped to save API quota.",
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
            strategy: "Pull integration strategy",
            strategyDesc:
                "How to reconcile diverged history on pull. merge keeps both sides and creates a merge commit; rebase replays local commits on top of the remote; reset discards local commits and takes the remote as-is.",
            strategyMerge: "Merge (keep both histories)",
            strategyRebase: "Rebase (linear history)",
            strategyReset: "Reset (remote wins, local commits dropped)",
            gitPath: "Git executable path",
            gitPathDesc: "Leave empty to use git from PATH. Only needed on Windows when git is not on PATH.",
        },
    },

    installer: {
        /**
         * Command palette names. Deliberately separate from the modal title:
         * the modal does not need a plugin-name prefix, but the command palette
         * does — Obsidian users search commands by plugin name.
         */
        cmdAddRepo: "OBSync: Add plugin repository",
        cmdBindExisting: "OBSync: Bind plugins already installed in this vault",
        cmdCheckUpdates: "OBSync: Check for plugin updates",
        cmdUpdateAll: "OBSync: Update all plugins",

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
        /**
         * Error messages.
         *
         * These used to be hard-coded in the logic layer, which is why English
         * users saw Chinese error text. Errors now carry a typed code plus
         * parameters; the prose lives here.
         */
        errors: {
            manifestNotJson: (context: string) =>
                `${context}: manifest.json is not valid JSON.`,
            manifestNotObject: (context: string) =>
                `${context}: manifest.json is not an object.`,
            manifestMissingField: (context: string, field: string) =>
                `${context}: manifest.json is missing the required field "${field}".`,
            manifestBadId: (context: string, id: string) =>
                `${context}: the plugin id "${id}" is invalid (lowercase letters, digits and hyphens only).`,
            missingManifest: (repo: string) =>
                `No manifest.json found in ${repo} — it may not be an Obsidian plugin repository.`,
            missingRequiredFiles: (repo: string, files: string) =>
                `Could not find ${files} in ${repo}; cannot install.`,
            missingBuildArtifacts:
                "If this is a source repository, the author may not have committed the build output.",
            incompatibleApp: (name: string, minVersion: string) =>
                `${name} requires Obsidian ${minVersion} or newer. Your version is too old, so the install was aborted.`,
            pluginIdConflict: (pluginId: string, repo: string) =>
                `The plugin id "${pluginId}" is already taken by another plugin; cannot install ${repo}.`,
            folderMissingRequired: (pluginId: string, file: string) =>
                `Plugin ${pluginId} is missing the required file ${file}; install aborted.`,
            writeFailedRolledBack: (pluginId: string) =>
                `Writing ${pluginId} failed. The previous state has been restored.`,
            writeFailedRollbackFailed: (pluginId: string) =>
                `Writing ${pluginId} failed, and restoring the previous state also failed. Please check the plugin folder manually.`,
            cannotEnablePlugin:
                "This version of Obsidian does not allow a plugin to enable other plugins.",
            communityIndexFailed: (status: number) =>
                `Could not fetch the community plugin index (HTTP ${status}). That index is hosted on GitHub, so it is unavailable when the network cannot reach it.`,
            rateLimitFallback: (host: string) =>
                `${host} API rate limit reached; falling back to installing from source files. ` +
                `Adding an access token in settings raises the limit significantly.`,
            apiUnavailableFallback: (host: string) =>
                `The ${host} API is temporarily unavailable; falling back to installing from source files.`,
            rateLimited: (host: string) => `${host} API rate limit reached.`,
        },

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
        updateBadge: (version: string) => `Update available → ${version}`,
        reinstall: "Reinstall",
        freeze: "Freeze (exclude from update checks)",
        unfreeze: "Unfreeze",
        frozen: "Frozen",
        openRepo: "Open repository in browser",
        remove: "Remove",
        removeConfirm: (name: string) =>
            `Remove ${name}?\n\nThe plugin folder will be deleted, including any custom files inside it.`,

        bindTitle: "Bind installed plugins",
        bindDesc:
            "Scans plugins already installed in this vault and resolves their source repository via the official community index. Selected ones join the tracking list for update checks. No plugin files are touched.",
        bindScanning: "Scanning installed plugins…",
        bindEmpty: "No new plugins to bind — they are all tracked already, or the vault has no plugins.",
        bindDetected: (count: number) => `${count} bindable plugin(s) detected`,
        bindSelectAll: "Select all / none",
        bindUnresolvedHeading: (count: number) =>
            `${count} plugin(s) with unrecognized source (not in the official community index):`,
        bindUnresolved: "Source unknown — add it manually via \"Add plugin repository\"",
        bindConfirm: (count: number) => `Bind selected (${count})`,
        bindLoadFailed: "Failed to scan installed plugins",
        bindDone: (count: number) => `Bound ${count} plugin(s); update checks now cover them.`,
    },

    sync: {
        viewTitle: "OBSync",
        statusIdle: "Ready",
        statusPulling: "Pulling…",
        statusPushing: "Pushing…",
        statusCommitting: "Committing…",
        notARepo: "This vault is not a git repository yet.",
        gitNotFound: "Could not find the git executable. Set its path in settings.",
        gitAuthFailed:
            "Remote authentication failed. Check that the access token for this platform is valid and has the required scope.",
        pushRejected:
            "The push was rejected by the remote. It likely has commits you do not have locally — pull first, then push.",
        noUpstream:
            "The current branch has no tracked remote branch, so it cannot be pulled. Set an upstream branch or push once first.",
        detachedHead:
            "HEAD is detached (not pointing at any branch), so pushing is not possible. Switch to a branch first.",
        nothingToCommit: "Nothing to commit.",
        noRemote: "No remote repository configured. Set the remote URL in settings.",
        conflictDetected: (count: number) =>
            `${count} conflicted file(s) detected. A conflict list has been written; resolve them and commit manually.`,

        cmdSync: "OBSync: Sync now (commit → pull → push)",
        cmdCommit: "OBSync: Commit all changes",
        cmdPush: "OBSync: Push to remote",
        cmdPull: "OBSync: Pull from remote",
        cmdInit: "OBSync: Initialize repository",
        cmdAbortMerge: "OBSync: Abort current merge (conflict recovery)",
        cmdEditRemote: "OBSync: Edit remote URL",
        cmdOpenFileOnRemote: "OBSync: Open current file in browser",
        cmdOpenFileHistoryOnRemote: "OBSync: View current file history in browser",

        // File context menu
        menuOpenOnRemote: "Open on remote",
        menuOpenHistoryOnRemote: "View history on remote",
        remoteLinkUnavailable:
            "Could not build a remote link. Make sure a GitHub or Gitee remote is configured and the repository has at least one commit.",

        actSync: "Sync now",
        actCommit: "Commit all",
        actPull: "Pull",
        actPush: "Push",
        actEditRemote: "Edit remote…",
        branchLabel: "Branch",

        editRemoteTitle: "Edit remote URL",
        editRemoteLabel: "Remote repository URL",
        editRemotePlaceholder: "https://github.com/owner/repo.git",
        editRemoteSaved: (url: string) => `Remote set to ${url}`,
        editRemoteInvalid:
            "That does not look like a git remote. Use a URL, git@host:path, or a local path.",
        editRemoteNotGithubOrGitee:
            "You can save and use this — syncing is plain git. But since the host is not GitHub or Gitee, no access token will be injected and \"Open on remote\" will not work (private repositories then rely on the OS credential helper).",
        repoInited: "Git repository initialized.",
        mergeAborted: "Merge aborted; the repository is back to the pre-pull state.",

        conflictGuideFile: "OBSync conflict guide.md",
        conflictGuideTitle: "Sync conflict guide",
        conflictGuideIntro:
            "The following files were changed both locally and remotely, and git could not decide which side to keep. Conflict regions are marked with <<<<<<< and >>>>>>> inside the files.",
        conflictGuideFiles: "Conflicted files:",
        conflictGuideResolve:
            "How to resolve: open each file, edit the conflicted region to keep what you want (remove the marker lines), then run \"OBSync: Sync now\" — the resolution will be committed and pushed.",
        conflictGuideAbort:
            "To discard this merge and return to the pre-pull state, run \"OBSync: Abort current merge\".",
        conflictGuideFooter: (time: string) => `Generated automatically by OBSync at ${time}. Safe to delete once resolved.`,
    },
} satisfies LocaleStrings;
