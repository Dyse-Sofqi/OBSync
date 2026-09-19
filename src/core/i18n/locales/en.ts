import type { LocaleStrings } from "./zh-cn";

/**
 * English. Must mirror the structure of `zh-cn.ts` exactly —
 * `satisfies` turns any missing or misspelled key into a compile error.
 */
export const en = {
    plugin: {
        name: "OBSync",
        ribbonTooltip: "OBSync: sync vaults and install plugins",
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

    host: {
        github: "GitHub",
        gitee: "Gitee",
        unknown: "Unknown host",
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
        cmdOpenSettings: "OBSync: Open settings",

        tabs: {
            // One tab now covers both plugins and themes (a single list with a
            // type badge), so the label names both — a themes-only label would
            // never be found by someone looking for their plugins.
            tracked: "Plugins & themes",
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
            autoCheckDesc: "Check tracked plugins and themes for updates shortly after Obsidian starts. Off by default — the check on opening this settings tab covers most cases.",
            autoCheckDelay: "Startup check delay (seconds)",
            autoCheckDelayDesc: "How long to wait before checking, so startup is not slowed down.",
            autoCheckOnSettingsOpen: "Check when opening settings",
            autoCheckOnSettingsOpenDesc: "Run an update check when this settings page opens. Repeated openings within a short window are skipped to save API quota.",
            tracked: "Tracked plugins and themes",
            trackedDesc: "Plugins and themes bound, installed or updated through OBSync.",
            trackedEmpty: "No plugins or themes added yet.",
            selfHeading: "OBSync itself",
            selfDesc:
                "Update OBSync itself. Only the new files are written; the running plugin is not reloaded — the new version takes effect after you restart Obsidian.",
            mirrorDiscovery: "Discover Gitee mirrors",
            mirrorDiscoveryDesc: "When installing a GitHub plugin, look for a Gitee mirror first: a same-named repository, or a same-named repository under your own Gitee account (the latter needs a Gitee token). Downloads then use the mirror — faster in mainland China.",
        },

        sync: {
            heading: "Vault sync",
            enabled: "Enable vault sync",
            enabledDesc:
                "Let OBSync sync this vault in the background. Turning it off stops the " +
                "automatic commit / push / pull timers; the sync commands stay available " +
                "(those are started by you).",
            desktopOnly: "Vault sync needs system git and is only available on desktop.",
            autoCommit: "Auto commit-and-sync interval (minutes)",
            autoCommitDesc:
                "Set to 0 to disable. This is not commit-only: each run does " +
                "commit -> pull -> push, the same chain as the \"Sync now\" command.",
            autoPush: "Auto push interval (minutes)",
            autoPushDesc:
                "Set to 0 to disable. This is an additional push timer; even at 0, " +
                "pushes still happen as part of the commit-and-sync timer above.",
            autoPull: "Auto pull interval (minutes)",
            autoPullDesc:
                "Set to 0 to disable. This is an additional pull timer; even at 0, " +
                "pulls still happen as part of the commit-and-sync timer above.",
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
        cmdBindExisting: "OBSync: Bind plugins and themes already installed in this vault",
        cmdCheckUpdates: "OBSync: Check for plugin and theme updates",
        cmdUpdateAll: "OBSync: Update all plugins and themes",

        /**
         * Names for the two tracked kinds. They have to read naturally inside a
         * sentence (e.g. `Writing theme "Minimal" failed`), because error prose
         * picks the word by kind — see `ofKind` in `installer/errors.ts`.
         */
        kindPlugin: "plugin",
        kindTheme: "theme",

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
        /** The version manager on a tracked plugin row (plugins only — themes are never pinned). */
        versionManage: "Version manager (roll back to a specific version)",
        versionManageTitle: "Choose a version",
        versionManageDesc:
            "Switch this plugin to another published version — picking an older one rolls it back. " +
            "Pick \"Latest release\" to follow the newest release again.",
        versionInstalled: (version: string) => `Installed: ${version}`,
        versionInstalledUnknown: "Installed: version unknown",
        versionCurrent: "current",
        versionLoading: "Fetching the version list…",
        versionNoneAvailable:
            "This repository publishes no releases (source install only), so there is no version to switch to.",
        versionFetchFailed: "Could not fetch the version list.",
        versionApply: "Switch to this version",
        versionSwitched: (name: string, version: string, source: string) =>
            `Switched ${name} to ${version} (from ${source})`,
        versionPinned: (version: string) => `Pinned to ${version}`,
        enableAfterInstall: "Enable after installing",
        install: "Install",
        installing: "Installing…",
        installFailed: "Install failed",
        installed: (name: string, version: string, source: string) =>
            `Installed ${name} ${version} (from ${source})`,
        /** `source` is composed by `features/installer/downloadSource.ts`. */
        updated: (name: string, version: string, source: string) =>
            `Updated ${name} to ${version} (from ${source})`,
        upToDate: (name: string) => `${name} is already up to date`,
        reinstalled: (name: string, source: string) => `Reinstalled ${name} (from ${source})`,
        removed: (name: string) => `Unbound ${name}; its files are untouched`,
        removeFailed: "Failed to unbind",
        sourceRaw: "Source: repository source file",
        mirrorUnused: (host: string, repo: string) =>
            `Found a possible ${host} mirror: ${repo}. It is not used by default — check the box above to switch to it.`,
        mirrorSource: (host: string) => `${host} mirror`,
        mirrorLine: (host: string, repo: string) =>
            `${host} mirror · ${repo} · used for downloads`,
        /** The confirm-a-mirror flow. Mirrors are never adopted without these screens. */
        versionCorrected: (names: string) =>
            `The installed version did not match the recorded one — corrected from the files on disk: ${names}`,
        duplicateFolders: (name: string, count: number) =>
            `${name}: ${count} plugin folders declare the same id, so which one Obsidian loads is undefined. ` +
            `Move the extra one (usually a leftover backup) out of the plugins folder and restart.`,
        mirrorSuggestionLine: (host: string, repo: string) =>
            `Possible ${host} mirror · ${repo} · not in use yet, needs confirmation`,
        mirrorConfirmTitle: "Confirm mirror source",
        mirrorConfirmDesc:
            "This item currently follows the source repository below. Another repository was found that looks like its mirror — please confirm whether downloads should switch to it.",
        mirrorConfirmSource: (host: string, repo: string) =>
            `Source repository (in use): ${host} · ${repo}`,
        mirrorConfirmCandidate: (host: string, repo: string) =>
            `Possible mirror: ${host} · ${repo}`,
        mirrorWarnHeading: "Check these two addresses yourself before confirming",
        mirrorWarnChecks:
            "The only evidence for calling this a mirror is that both manifests declare the same id. " +
            "That proves it is the same plugin — it does **not** prove it is the same code, the same " +
            "author, or that it keeps up with the source: a fork, or anyone re-uploading under the same " +
            "id, passes this check too.",
        mirrorWarnRisk:
            "Plugin code can read and write your entire vault. After you confirm, both downloads and " +
            "update checks go to the mirror — if it is not maintained by the original author, you are " +
            "not just changing a download source, you are changing who you trust.",
        mirrorWarnHowTo:
            "How to check: open the mirror repository and see whether its author, homepage or README " +
            "points back at the source repository; the latest version numbers should also be close. " +
            "If in doubt, leave it as is — nothing breaks by keeping the current source.",
        mirrorConfirmUse: (host: string) => `Use the ${host} mirror`,
        mirrorConfirmKeep: "Keep the current source",
        mirrorConfirmTooltip: "Confirm mirror source",
        mirrorConfirmed: (host: string, repo: string) =>
            `Now using the ${host} mirror ${repo}; the next update downloads from it`,
        mirrorDismissed: (repo: string) => `Dismissed the mirror suggestion for ${repo}`,
        mirrorToggleDesc:
            "When checked, downloads use this mirror. The only evidence is that both manifests declare " +
            "the same id, which does not prove it is the same code — only check it if you trust the address.",
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
            missingManifest: (repo: string, of: string) =>
                `No manifest.json found in ${repo} — it may not be an Obsidian ${of} repository.`,
            missingRequiredFiles: (repo: string, files: string, of: string) =>
                `Could not find ${files} in ${repo}; cannot install that ${of}.`,
            missingBuildArtifacts:
                "If this is a source repository, the author may not have committed the build output.",
            incompatibleApp: (name: string, minVersion: string) =>
                `${name} requires Obsidian ${minVersion} or newer. Your version is too old, so the install was aborted.`,
            pluginIdConflict: (pluginId: string, repo: string) =>
                `The plugin id "${pluginId}" is already taken by another plugin; cannot install ${repo}.`,
            folderMissingRequired: (id: string, file: string, of: string) =>
                `The ${of} "${id}" is missing the required file ${file}; install aborted.`,
            writeFailedRolledBack: (id: string, of: string) =>
                `Writing the ${of} "${id}" failed. The previous state has been restored.`,
            writeFailedRollbackFailed: (id: string, of: string) =>
                `Writing the ${of} "${id}" failed, and restoring the previous state also failed. Please check its folder manually.`,
            cannotEnablePlugin:
                "This version of Obsidian does not allow a plugin to enable other plugins.",
            selfIdMismatch: (repo: string, id: string) =>
                `The plugin id in ${repo} is "${id}", not OBSync itself (obsync) — the update was aborted so it cannot overwrite another plugin.`,
            selfUpdateDowngrade: (current: string, latest: string) =>
                `The latest remote version ${latest} is older than the running ${current}; aborted — updating should not downgrade you.`,
            communityIndexFailed: (status: number) =>
                `Could not fetch the official community index (HTTP ${status}). That index is hosted on GitHub, so it is unavailable when the network cannot reach it.`,
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
        updateAll: "Update all",
        // These now cover plugins and themes alike — "item(s)" instead of
        // "plugin(s)", or updating a theme would report "Updated 1 plugin".
        updatedMany: (count: number, names: string, source: string) =>
            `Updated ${count} item(s): ${names} (from ${source})`,
        updateFailedMany: (count: number) => `${count} item(s) failed to update`,
        checkFailed: "Update check failed",
        checking: "Checking for updates…",
        updateAvailable: (name: string, version: string) => `${name} has a newer version: ${version}.`,
        updatesAvailable: (count: number, names: string) =>
            `${count} item(s) can be updated: ${names}`,
        checkNone: "All plugins and themes are up to date.",
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
        /**
         * Unbind. The wording must say files are kept: this used to delete the
         * whole folder (and disable the plugin first), and now it only drops the
         * entry from the tracking list — see `InstallerService.unbind`.
         */
        remove: "Unbind (files are kept)",

        bindTitle: "Bind installed plugins and themes",
        bindDesc:
            "Scans plugins and themes already installed in this vault and resolves their source repository via the official community index. Selected ones join the tracking list for update checks. No files are touched, and your active theme is never switched.",
        bindScanning: "Scanning installed plugins and themes…",
        bindEmpty: "No new plugins or themes to bind — they are all tracked already, or the vault has none.",
        bindPluginsHeading: (count: number) => `${count} bindable plugin(s) detected`,
        bindThemesHeading: (count: number) => `${count} bindable theme(s) detected`,
        bindSelectAll: "Select all / none",
        bindUnresolvedHeading: (count: number) =>
            `${count} plugin(s) with unrecognized source (not in the official community index):`,
        bindUnresolved: "Source unknown — add it manually via \"Add plugin repository\"",
        bindUnresolvedThemesHeading: (count: number) =>
            `${count} theme(s) with unrecognized source (not in the official community index):`,
        /**
         * Themes get a manual repository field, plugins do not — a deliberate
         * asymmetry: plugins have "Add plugin repository" as a fallback entry
         * point, while themes have no install path in this version, so without
         * this field an unrecognized theme could never be tracked.
         */
        bindUnresolvedTheme: "Source unknown — enter the repository to bind it",
        bindRepoPlaceholder: "e.g. owner/repo or a full repository URL",
        bindManualBind: "Bind",
        bindManualFailed: "Failed to bind the theme",
        bindConfirm: (count: number) => `Bind selected (${count})`,
        bindLoadFailed: "Failed to scan installed plugins and themes",
        bindDone: (count: number) => `Bound ${count} item(s); update checks now cover them.`,

        /**
         * OBSync updating itself.
         *
         * The pending-restart line matters most: we do **not** reload ourselves,
         * so the files on disk are newer than the running code. Without saying so
         * the user would believe the new version is already active.
         */
        selfNotChecked: (version: string) => `Version ${version} · not checked yet`,
        selfUpToDate: (version: string) => `OBSync ${version} is up to date`,
        selfUpdateAvailable: (current: string, latest: string) =>
            `Version ${latest} is available (you are on ${current})`,
        selfPendingRestart: (version: string) =>
            `${version} downloaded — restart Obsidian to apply it`,
        selfUpdating: "Downloading the new version…",
        selfUpdateDone: (version: string) =>
            `OBSync ${version} downloaded — restart Obsidian to apply it`,
        selfCheckFailed: (reason: string) => `Could not check for OBSync updates: ${reason}`,
        selfUpdateFailed: "Failed to update OBSync",
    },

    sync: {
        viewTitle: "OBSync",
        statusPulling: "Pulling…",
        statusPushing: "Pushing…",
        statusCommitting: "Committing…",
        notARepo: "This vault is not a git repository yet.",
        gitNotFound: "Could not find the git executable. Set its path in settings.",
        gitAuthFailed:
            "Remote authentication failed. Check that the access token for this platform is valid and has the required scope.",
        /**
         * Deliberately separate from the line above: the token is fine, the
         * problem is the username the plugin sent.
         */
        gitCredentialUsernameRejected:
            "The platform rejected the username in the credential — the token itself is valid. This is a plugin configuration error (the platform only accepts specific usernames). Please report this.",
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
        editRemoteHint: {
            invalid:
                "That does not look like a git remote. Use a URL, git@host:path, or a local path.",
            credentials:
                "This URL carries a username and a token. Saving it writes them in plain text to the vault's .git/config — visible to `git remote -v`, and carried along by any backup or sync of the vault. Prefer a URL without credentials and put the token in the \"Access token\" field above (it is kept in the OS secret storage, not on disk).",
            notGithubOrGitee:
                "You can save and use this — syncing is plain git. But since the host is not GitHub or Gitee, no access token will be injected and \"Open on remote\" will not work (private repositories then rely on the OS credential helper).",
        },
        // ── .gitignore ──
        gitignoreCreated:
            "Created a .gitignore (it excludes Obsidian's workspace state files, which would otherwise cause conflicts between devices).",
        cmdEditGitignore: "OBSync: Edit .gitignore",
        /** Contents of the .gitignore written when initialising a repository. */
        gitignoreTemplate: [
            "# Created by OBSync.",
            "",
            "# Obsidian's workspace layout (panels, tabs, cursor positions). It is",
            "# per-device; syncing it only creates conflicts — the single most common",
            "# pitfall when syncing a vault across devices.",
            ".obsidian/workspace.json",
            ".obsidian/workspace-mobile.json",
            "",
            "# Obsidian's trash",
            ".trash/",
            "",
            "# OS junk",
            ".DS_Store",
            "Thumbs.db",
            "",
            "# Add anything else you want to ignore below.",
        ].join("\n"),

        repoInited: "Git repository initialized.",
        mergeAborted: "Merge aborted; the repository is back to the pre-pull state.",


        // ── Connection test ──
        diagnoseHeading: "Connection test",
        diagnoseDesc:
            "Check whether the sync configuration works and verify the access token. Read-only — nothing is modified.",
        diagnoseRun: "Test connection",
        diagnoseRunning: "Testing…",
        // Wording is deliberately limited to read access: this test uses
        // ls-remote, so it cannot verify the push path. Saying "sync is ready"
        // would imply push was checked too (measured: Gitee's credential
        // username rule is only enforced on the push path).
        diagnoseAllPassed: "All checks passed — the remote is readable.",
        diagnoseScopeNote:
            "Only read access (ls-remote) was verified. Push permission and credential rules can only be confirmed by an actual push.",
        diagnoseHasFailures: "Problems found — see below.",
        diagnoseCheck: {
            git: "git executable",
            repo: "git repository",
            remote: "Remote URL",
            platform: "Host and token",
            access: "Remote access",
        },
        diagnoseDetail: {
            gitOk: "Available",
            gitFailed: (detail: string) => `Not available: ${detail}`,
            repoOk: "Initialised",
            repoFailed: 'Not initialised yet — run the "OBSync: Initialise repository" command first',
            remoteOk: (url: string) => url,
            remoteFailed: 'Not configured — set it with the "OBSync: Edit remote URL" command',
            platformOk: (host: string) => `${host}, access token configured`,
            platformNoToken: (host: string) =>
                `${host}, **no access token configured** — public repositories will work, private ones will fail`,
            platformUnknown:
                "Host not recognised, so no token will be injected (private repositories fall back to the OS credential helper)",
            accessOk: (count: string) => `Reachable, read ${count} branch(es)`,
        },

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
