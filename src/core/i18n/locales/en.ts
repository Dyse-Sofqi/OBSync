import type { LocaleStrings } from "./zh-cn";

/**
 * English. Must mirror the structure of `zh-cn.ts` exactly —
 * `satisfies` turns any missing or misspelled key into a compile error.
 */

/** Shared by the confirm dialog (prefix + clickable address) and the add-repo modal (whole line). */
const mirrorCandidatePrefix = "Possible mirror: ";

export const en = {
    plugin: {
        name: "SyncHub",
        ribbonSync: "SyncHub: open the repository sync view",
        ribbonInstaller: "SyncHub: install community plugins",
        ribbonImages: "SyncHub: open the image manager",
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
        cmdOpenSettings: "SyncHub: Open settings",

        tabs: {
            // One tab now covers both plugins and themes (a single list with a
            // type badge), so the label names both — a themes-only label would
            // never be found by someone looking for their plugins.
            tracked: "Plugins & themes",
            installer: "Plugin installer",
            sync: "Vault sync",
            images: "Image sync",
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
            statusBarFullWidth: "Status bar spans the full width",
            statusBarFullWidthDesc:
                "Stretch the status bar across the screen so the sync item can sit at the **far left** (otherwise there is no free space there). Turning this off restores Obsidian's own layout (a cluster in the bottom-right); the sync item stays **first** in that cluster — nothing is lost, it just no longer fills the whole strip.",
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
            trackedDesc: "Plugins and themes bound, installed or updated through SyncHub.",
            trackedEmpty: "No plugins or themes added yet.",
            selfHeading: "SyncHub itself",
            selfDesc:
                "Update SyncHub itself. Only the new files are written; the running plugin is not reloaded — the new version takes effect after you restart Obsidian.",
            /** Says what empty means, and what happens if the address is wrong — see the zh-cn note. */
            selfSource: "Self-update source",
            selfSourceDesc:
                "Empty = the official repository (github.com/Dyse-Sofqi/SyncHub). If GitHub is slow " +
                "or blocked, enter a mirror address — it is then used every time, with no automatic " +
                "probing. Before writing, the remote manifest's id must be ob-sync, so a wrong " +
                "address cannot overwrite another plugin.",
            selfSourcePlaceholder: "https://gitee.com/sofqi/SyncHub",
            mirrorDiscovery: "Discover Gitee mirrors",
            mirrorDiscoveryDesc: "When installing a GitHub plugin, look for a Gitee mirror first: a same-named repository, or a same-named repository under your own Gitee account (the latter needs a Gitee token). Downloads then use the mirror — faster in mainland China.",
        },

        sync: {
            heading: "Vault sync",
            enabled: "Enable vault sync",
            enabledDesc:
                "Let SyncHub sync this vault in the background. Turning it off stops the " +
                "automatic commit / push / pull timers; the sync commands stay available " +
                "(those are started by you).",
            /**
             * Replacement description while the toggle is suspended (strategy = reset,
             * see `Automatics.start()`). Says both *why* it is greyed out and *how* to
             * resume — greying it out without an explanation reads as a broken plugin.
             */
            enabledSuspendedByReset:
                "Paused: the pull integration strategy is reset, so every automatic sync " +
                "would discard what was just committed. Switch back to merge or rebase to resume.",
            desktopOnly: "Vault sync needs system git and is only available on desktop.",
            /**
             * Notes shown at the top of this page, right under the heading. Both are
             * traps that only bite under a *combination* of settings (reset strategy +
             * automatic sync on; editing the same file on two devices), so they would go
             * unread if buried in a single option's description.
             *
             * The first one is the other half of the suspension logic in
             * `Automatics.start()` — change one, change the other.
             */
            notesHeading: "Notes",
            notes: [
                "With the pull integration strategy set to reset, every automatic sync runs " +
                    "commit -> pull -> push, and reset discards what was just committed. Automatic " +
                    "sync is therefore paused while reset is selected; it switches back on when " +
                    "you return to merge or rebase.",
                "If a note was just changed on another device while you are editing it here, an " +
                    "automatic pull may overwrite what you have. Consider turning automatic sync " +
                    "off while editing the same file on multiple devices.",
            ],
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

            // The .gitignore section: editable in place so users can see what is
            // currently ignored without leaving the settings page.
            gitignoreHeading: "Ignore rules (.gitignore)",
            gitignoreDesc:
                "One rule per line; lines starting with `#` are comments. Changes here are written " +
                "straight to the .gitignore in the vault root — no separate editor needed. To edit it " +
                "in Obsidian's own editor, use the button below.",
            gitignoreMissing: "not created yet",
            gitignoreDirty: "unsaved changes",
            gitignoreSaved: "saved",
            gitignoreSave: "Save",
            gitignoreSaving: "Saving…",
            gitignoreRestore: "Fill in defaults",
            gitignoreOpen: "Open in editor",
            gitignoreSavedNotice: "Saved .gitignore.",
            gitignoreSaveFailed:
                "Could not save .gitignore — the file on disk still holds the previous content.",
        },

        images: {
            heading: "Image sync",
            notesHeading: "Things to know",
            notes: [
                "Syncing only ever copies: every round fills the gaps on both sides (download what the " +
                    "cloud has extra, upload what the vault has extra). Nothing is deleted. Deletion is " +
                    "always something you start yourself — see the next item.",
                "When you delete a managed image on this device, the plugin asks whether the cloud copy " +
                    "should go too. Deleting is irreversible (R2 has no recycle bin); choosing \"keep\" " +
                    "records a marker so the next sync will not download it back. That prompt can be changed " +
                    "in the \"Conflicts and deletion\" section.",
                "Images inside the managed folders are usually tracked by git as well. The two paths are " +
                    "independent: git keeps version history, R2 keeps images out of the repository and makes " +
                    "them linkable from outside. SyncHub will not touch your .gitignore.",
            ],
            enabled: "Enable image sync",
            enabledDesc:
                "Let SyncHub sync images at startup and in the background. Turning this off stops all automatic " +
                "syncing; the \"Sync now\" button on this page still works (that is you asking for it).",
            folders: "Managed image folders",
            foldersDesc:
                "One per line, as vault-relative paths (for example attachments). Only images inside these " +
                "folders are processed, and deletions only ever happen inside them — this is the single " +
                "boundary of what the plugin may touch. Use . for the whole vault; **the default is the " +
                "repository root (whole vault)**: pick one with \"Browse…\" below, or press \"Restore " +
                "default\" to come back to it.",
            foldersPlaceholder: "attachments\nassets/images",
            foldersEmpty:
                "No folder specified, so sync will not run. Type one (for example attachments), pick one " +
                "with \"Browse…\", or press \"Restore default\" to go back to the repository root.",
            foldersBrowse: "Browse…",
            foldersReset: "Restore default",
            folderPickerPlaceholder: "Search folders…",
            folderPickerRoot: "Repository root (whole vault)",
            folderPickerIncluded: "Already managed",

            connectionHeading: "Cloudflare R2 connection",
            accountId: "R2 account ID",
            accountIdDesc:
                "The account ID shown on the R2 overview page in the Cloudflare dashboard. The bare ID is " +
                "enough (.r2.cloudflarestorage.com is appended for you); a full storage endpoint works too.",
            accountIdPlaceholder: "e.g. 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
            bucket: "Bucket name",
            bucketDesc:
                "Which bucket the images go into. Objects outside the prefix are never touched, but a " +
                "**dedicated bucket** is the least surprising setup.",
            accessKeyId: "Access Key ID",
            accessKeyIdDesc:
                "Create it under R2's \"Manage API tokens\" with at least object read & write permission. " +
                "This value is not a secret and will be synced to your other devices.",
            secretKey: "Secret Access Key",
            secretKeyDesc:
                "The value shown **only once** when the token is created. It is kept on this machine only " +
                "(system keychain) — never written to data.json, never synced.",
            secretPlaceholder: "Paste the secret…",
            secretSave: "Save secret",
            secretClear: "Clear secret",
            secretSaved: "R2 secret saved",
            secretCleared: "R2 secret cleared",
            secretConfigured: "Configured",
            secretNotConfigured: "Not configured",
            prefix: "Cloud prefix",
            prefixDesc:
                "Prefix for the object keys (for example images). Leave empty to put them at the bucket root. " +
                "It only decides *where* they live; changing it does not invalidate the sync state.",
            publicBaseUrl: "Public base URL",
            publicBaseUrlDesc:
                "A custom domain or r2.dev domain, used to build image links. Leave it empty and " +
                "\"Copy cloud link\" stays unavailable — the storage endpoint requires a signature on every " +
                "read, so a link built from it would never open. This is not guessed for you.",

            conflictHeading: "Conflicts and deletion",
            conflictPolicy: "When both sides changed",
            conflictPolicyDesc:
                "The same file changed locally and in the cloud. Images cannot be merged automatically, so one " +
                "side has to win.",
            conflictNewer: "Newest wins (compare modification times)",
            conflictLocal: "Local wins",
            conflictRemote: "Cloud wins",
            deleteRemotePolicy: "When deleting a local image, ask whether to delete the cloud backup too",
            /**
             * All three options need their consequence spelled out — this is a dropdown, so the
             * user only ever sees the current value. The "never" half matters most: without it,
             * a deleted image comes back on the next sync (mirroring refills from the cloud),
             * which looks like a bug.
             */
            deleteRemotePolicyDesc:
                "What happens to the cloud backup when you delete an image from the vault and the cloud " +
                "still has a copy: \"Ask each time\" opens one prompt; \"Always sync the cloud\" deletes " +
                "it right away (R2 has no recycle bin — deletion is irreversible); \"Never sync the " +
                "cloud\" leaves the cloud untouched — but that copy will be **downloaded back** on the " +
                "next sync (mirroring fills in both directions).",
            deleteRemoteAsk: "Ask each time",
            deleteRemoteAlways: "Always sync the cloud",
            deleteRemoteNever: "Never sync the cloud",
            autoSync: "Automatic sync interval (minutes)",
            autoSyncDesc:
                "0 disables it (the default). Each run fills in whatever is missing on either side (uploads " +
                "and downloads). Syncing never deletes anything — deletions only happen after you delete a " +
                "local image and answer the prompt.",

            compressHeading: "Crop and compression defaults",
            compressQuality: "Default quality",
            compressQualityDesc:
                "Default quality for lossy formats (JPEG / WebP), 10–100. PNG is lossless and ignores it.",
            compressMaxEdge: "Default longest edge (pixels)",
            compressMaxEdgeDesc:
                "The default scaling limit in the crop/compress dialog. 0 means no scaling. It only shrinks — " +
                "enlarging a small image just makes it blurrier and bigger.",
            compressFormat: "Default output format",
            compressFormatDesc:
                "\"Keep as is\" does not mean \"no compression\": a JPEG stays a JPEG but is still re-encoded " +
                "at the chosen quality; only the container is preserved.",

            actionsHeading: "Actions",
            test: "Test connection",
            testing: "Testing…",
            testOk: (bucket: string) => `Connection works — bucket ${bucket} is reachable.`,
            testFailed: "Connection test failed",
            preview: "Preview changes",
            previewing: "Comparing…",
            syncNow: "Sync now",
            syncing: "Syncing…",
            openManager: "Open the image manager",
            openManagerDesc:
                "Lists every image in the managed folders by three states — local, cloud, linked — " +
                "so you can filter out orphans, not-yet-uploaded and cloud-only images, then sync, " +
                "compress, rename or delete them in bulk.",
        },
    },

    installer: {
        /**
         * Command palette names. Deliberately separate from the modal title:
         * the modal does not need a plugin-name prefix, but the command palette
         * does — Obsidian users search commands by plugin name.
         */
        cmdAddRepo: "SyncHub: Add plugin repository",
        cmdBindExisting: "SyncHub: Bind plugins and themes already installed in this vault",
        cmdCheckUpdates: "SyncHub: Check for plugin and theme updates",
        cmdUpdateAll: "SyncHub: Update all plugins and themes",

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
        repoPlaceholder: "e.g. Dyse-Sofqi/SyncHub or https://gitee.com/owner/repo",
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
        /** The "download source" section of the version dialog (plugins only). */
        versionSourceLabel: "Download source",
        versionSourceCurrent: (host: string, repo: string) => `Downloading from: ${host} · ${repo}`,
        versionSourceOrigin: (host: string, repo: string) => `Source repository: ${host} · ${repo}`,
        versionMirrorFoundPrefix: "Possible mirror found: ",
        versionMirrorNone:
            "No mirror found. Discovery only guesses two candidates: a same-named repository, and a " +
            "same-named repository under your own Gitee account (the latter needs a Gitee token first). " +
            "If the mirror lives under some other account, type its address below.",
        versionUseMirror: (host: string) => `Use the ${host} mirror`,
        versionManualLabel: "Mirror address",
        versionManualDesc:
            "For example sofqi/Trefoil, or paste a full URL. The plugin id there must match this entry, or the switch is refused.",
        versionManualPlaceholder: "e.g. sofqi/Trefoil",
        versionManualApply: "Use this address",
        versionManualChecking: "Checking the address…",
        versionMirrorFailed: "Could not switch to that mirror",
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
        /** Prefix and address are separate so the address can render as a clickable link. */
        mirrorSourcePrefix: "Source repository (in use): ",
        mirrorCandidatePrefix,
        /** The composed sentence, used as a settings-row name in the add-repo modal. */
        mirrorConfirmCandidate: (host: string, repo: string) =>
            `${mirrorCandidatePrefix}${host} · ${repo}`,
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
                `The plugin id in ${repo} is "${id}", not SyncHub itself (ob-sync) — the update was aborted so it cannot overwrite another plugin.`,
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
            /**
             * "The release does list the file, but the download failed" — kept apart from
             * `missingRequiredFiles` because the next step is completely different
             * (check your network instead of asking the author).
             */
            assetDownloadFailed: (repo: string, files: string, of: string) =>
                `Could not download ${files} from ${repo}: the ${of}'s release does list the file, ` +
                `so this is a failed download rather than a missing file (release asset CDNs are ` +
                `often unreachable from mainland China). Check your network and retry, or use the Gitee mirror.`,
            /** A hand-typed mirror whose plugin id does not match — refused, not merely warned about. */
            mirrorIdMismatch: (repo: string, expected: string, found: string) =>
                `The plugin id in ${repo} is "${found}", but this entry tracks "${expected}" — ` +
                `the switch was refused so nothing wrong gets installed. Check that the address points at a mirror of the same plugin.`,
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
        /** Long-running progress notices (with a spinner) — they must say *what* is happening. */
        progressChecking: (name: string) => `${name}: checking for updates…`,
        progressUpdating: (name: string) => `${name}: updating…`,
        progressFetching: (name: string, file: string) => `${name}: fetching ${file}…`,
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
         * SyncHub updating itself.
         *
         * The pending-restart line matters most: we do **not** reload ourselves,
         * so the files on disk are newer than the running code. Without saying so
         * the user would believe the new version is already active.
         */
        selfNotChecked: (version: string) => `Version ${version} · not checked yet`,
        selfUpToDate: (version: string) => `SyncHub ${version} is up to date`,
        selfUpdateAvailable: (current: string, latest: string) =>
            `Version ${latest} is available (you are on ${current})`,
        selfPendingRestart: (version: string) =>
            `${version} downloaded — restart Obsidian to apply it`,
        selfUpdating: "Downloading the new version…",
        selfUpdateDone: (version: string) =>
            `SyncHub ${version} downloaded — restart Obsidian to apply it`,
        selfCheckFailed: (reason: string) => `Could not check for SyncHub updates: ${reason}`,
        selfUpdateFailed: "Failed to update SyncHub",
    },

    sync: {
        // Renamed from "Source control" on 2026-09-19: the in-panel heading is
        // gone, so this is the only name the user sees — and "source control"
        // is git's word, not this plugin's job (it syncs the vault to a remote).
        viewTitle: "Repository sync",
        statusPulling: "Pulling…",
        statusPushing: "Pushing…",
        statusCommitting: "Committing…",
        notARepo: "This vault is not a git repository yet.",
        gitNotFound: "Could not find the git executable. Set its path in settings.",
        gitAuthFailed:
            "Remote authentication failed. Check that the access token for this platform is valid and has the required scope.",
        /**
         * git stalled and was aborted. This type exists so "nothing happens"
         * is never the whole story: it says what happened and what to try.
         */
        gitTimeout:
            "git produced no output for a long time, so this operation was aborted. Check your network (or proxy) and try again. If it keeps happening, the remote repository may be very large or may require credentials — for the latter, enter an access token in the settings.",
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
        // Note: this does NOT claim "in sync with the remote" — ahead === 0 only
        // means there is nothing new locally; you may still be behind.
        pushUpToDate: "Nothing to push (no new local commits).",
        pushNeedsCommit: (count: number) =>
            `Push only sends **committed** content, and you have ${count} uncommitted change(s). ` +
            `Use "Commit" (or "Sync now") first.`,
        pushDonePending: (count: number) =>
            `Pushed to the remote. Note: ${count} change(s) are still uncommitted — pushing does not commit them.`,
        pushDone: "Pushed to the remote.",
        commitsNotPushed: (count: number) =>
            `Committed; ${count} commit(s) are not pushed yet (use "Push" or "Sync now").`,
        syncedInSync: (size?: string) =>
            size
                ? `In sync: the local branch matches the remote · repository ${size}`
                : "In sync: the local branch matches the remote",

        repoSizeLabel: "Repository size",
        repoSizeDesc: (size: string, objects: number) => `${size} (${objects} object(s))`,
        pendingChangesLabel: "Pending changes",
        pendingChangesDesc: (size: string, files: number) => `${size} (${files} file(s))`,
        sizeUnknown: "unavailable",
        noRemote: "No remote repository configured. Set the remote URL in settings.",
        conflictDetected: (count: number) =>
            `${count} conflicted file(s) detected. A conflict list has been written; resolve them and commit manually.`,

        cmdSync: "SyncHub: Sync now (commit → pull → push)",
        cmdCommit: "SyncHub: Commit all changes",
        cmdPush: "SyncHub: Push to remote",
        cmdPull: "SyncHub: Pull from remote",
        cmdInit: "SyncHub: Initialize repository",
        cmdAbortMerge: "SyncHub: Abort current merge (conflict recovery)",
        cmdEditRemote: "SyncHub: Edit remote URL",
        cmdOpenFileOnRemote: "SyncHub: Open current file in browser",
        cmdOpenFileHistoryOnRemote: "SyncHub: View current file history in browser",
        cmdOpenDiff: "SyncHub: View diff of the current file",

        // File context menu
        menuOpenOnRemote: "Open on remote",
        menuOpenHistoryOnRemote: "View history on remote",
        remoteLinkUnavailable:
            "Could not build a remote link. Make sure a GitHub or Gitee remote is configured and the repository has at least one commit.",

        actSync: "Sync now",
        // Tooltips for the three actions: "commit" and "push" are different
        // things (local vs remote) and the buttons are only one word each.
        actSyncHint: "Commit → pull → push, in one chain",
        actCommitHint: "Commit all changes to the local repository (no push)",
        actPushHint: "Pushes **committed** content only; it never commits for you",
        actCommit: "Commit",
        actPull: "Pull",
        actPush: "Push",
        actEditRemote: "Edit remote…",
        branchLabel: "Branch",

        // Sidebar detail view (see the zh-CN locale for why these exist).
        // `cmdOpenView` and `viewTitle` must stay separate: command names need the
        // SyncHub prefix to be findable in the command palette, panel titles do not.
        cmdOpenView: "SyncHub: Open repository sync panel",
        statusBarHint: "Click to open the repository sync panel",
        actRefresh: "Refresh",
        actInit: "Initialise repository",
        actStage: "Stage this file",
        actUnstage: "Unstage this file",
        actStageAll: "Stage all",
        actUnstageAll: "Unstage all",
        actOpenFile: "Open this file",
        actOpenFileOnRemote: "Open this file on the remote",
        actDiff: "View diff",
        actAbortMerge: "Abort this merge",
        sectionStaged: (count: number) => `Staged changes (${count})`,
        sectionChanges: (count: number) => `Changes (${count})`,
        sectionConflicts: (count: number) => `Conflicts (${count})`,
        sectionHistory: "Recent commits",
        historyEmpty: "No commits yet.",
        historyFailed: "Could not read the commit history.",
        commitOnRemote: "View this commit on the remote",
        actDiffCommit: "View this commit's changes",
        remoteLabel: "Remote",
        detachedHeadLabel: "Detached HEAD (not on any branch)",
        aheadOf: (count: number) => `${count} commit(s) ahead of the remote`,
        behindOf: (count: number) => `${count} commit(s) behind the remote`,
        inSyncWithRemote: "In sync with the remote",
        noUpstreamHint:
            "This branch does not track a remote branch yet; pushing will set it up.",
        conflictHint:
            "These files changed both locally and on the remote, so git cannot decide which side to keep. Resolve them and commit, or abort this merge.",

        // Diff view. `section` is indexed by kind (`t.sync.diff.section[kind]`).
        diff: {
            title: "Diff",
            section: {
                working: "Working tree changes (unstaged)",
                staged: "Staged changes",
                commit: "Changes in this commit",
            },
            loading: "Reading diff…",
            loadFailed: "Could not read the diff.",
            noChanges: "Nothing to show.",
            binary: "Binary file — content diff not shown.",
            renamed: "Contents unchanged; the file was only renamed.",
            tooLarge: "File is too large; content diff not shown.",
            truncated: "Too much content — only the beginning is shown.",
            noNewline: "(no newline at end of file)",
            stats: (additions: number, deletions: number) => `+${additions} −${deletions}`,
        },

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
        cmdEditGitignore: "SyncHub: Edit .gitignore",
        gitignoreOpenFailed:
            "Could not open .gitignore in Obsidian's editor. Use the box on the \"Vault sync\" " +
            "settings tab instead, or open the .gitignore in the vault root with a system editor.",
        /**
         * Contents of the .gitignore written when initialising a repository.
         *
         * The parameter is the vault's **config directory name** (`vault.configDir`),
         * not a hardcoded `.obsidian`: users can rename it, and a hardcoded value
         * would make every one of these rules match nothing.
         */
        gitignoreTemplate: (configDir: string) =>
            [
                "# Created by SyncHub.",
                "",
                "# Obsidian's workspace layout (panels, tabs, cursor positions). It is",
                "# per-device; syncing it only creates conflicts — the single most common",
                "# pitfall when syncing a vault across devices.",
                `${configDir}/workspace.json`,
                `${configDir}/workspace-mobile.json`,
                "",
                "# This plugin's own settings (sync interval, pull strategy…). They are",
                "# per-device; syncing them only makes two devices overwrite each other's",
                "# settings.",
                `${configDir}/plugins/ob-sync/data.json`,
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
            repoFailed: 'Not initialised yet — run the "SyncHub: Initialise repository" command first',
            remoteOk: (url: string) => url,
            remoteFailed: 'Not configured — set it with the "SyncHub: Edit remote URL" command',
            platformOk: (host: string) => `${host}, access token configured`,
            platformNoToken: (host: string) =>
                `${host}, **no access token configured** — public repositories will work, private ones will fail`,
            platformUnknown:
                "Host not recognised, so no token will be injected (private repositories fall back to the OS credential helper)",
            accessOk: (count: string) => `Reachable, read ${count} branch(es)`,
        },

        conflictGuideFile: "SyncHub conflict guide.md",
        conflictGuideTitle: "Sync conflict guide",
        conflictGuideIntro:
            "The following files were changed both locally and remotely, and git could not decide which side to keep. Conflict regions are marked with <<<<<<< and >>>>>>> inside the files.",
        conflictGuideFiles: "Conflicted files:",
        conflictGuideResolve:
            "How to resolve: open each file, edit the conflicted region to keep what you want (remove the marker lines), then run \"SyncHub: Sync now\" — the resolution will be committed and pushed.",
        conflictGuideAbort:
            "To discard this merge and return to the pre-pull state, run \"SyncHub: Abort current merge\".",
        conflictGuideFooter: (time: string) => `Generated automatically by SyncHub at ${time}. Safe to delete once resolved.`,
    },

    images: {
        formatOption: {
            keep: "Keep as is",
            jpeg: "JPEG",
            webp: "WebP",
            png: "PNG",
        },

        cmdSync: "SyncHub: sync images to the cloud",
        cmdPreview: "SyncHub: preview image sync changes",
        cmdEdit: "SyncHub: crop / compress the current image",
        cmdCopyLink: "SyncHub: copy the current image's cloud link",
        cmdManage: "SyncHub: open the image manager",

        toolbar: {
            crop: "Crop / compress",
            copyLink: "Copy cloud link",
        },

        notice: {
            syncDone: (uploaded: number, downloaded: number) =>
                `Image sync finished: ${uploaded} uploaded, ${downloaded} downloaded.`,
            syncNothing: "Image sync finished: local and cloud already match, nothing to do.",
            syncFailed: "Image sync failed",
            syncFailedMany: (count: number) => `${count} file(s) failed`,
            previewFailed: "Could not preview image sync changes",
            linkCopied: (url: string) => `Cloud link copied: ${url}`,
            noPublicBase:
                "No public base URL is configured, so a link cannot be built. Set a custom domain or r2.dev " +
                "domain under Image sync settings.",
            notInScope: "This image is not inside a managed image folder, so SyncHub will not sync it.",
            notConfigured:
                "Image sync is not configured yet. Fill in the R2 details and the managed image folders on " +
                "the Image sync settings page first.",
            editorOpenFailed: "Could not open the image editor",
            singleUploadFailed: "Uploading this image failed (the local save was not affected)",
            deleteBackupFailed: "Could not delete the cloud backup",
            deleteBackupFailedMany: (count: number) => `${count} cloud backup(s) could not be deleted.`,
            remoteDeleted: (count: number) => `Deleted ${count} cloud backup(s).`,
            remoteKept: (count: number) =>
                `Kept ${count} cloud backup(s). The local copies are gone and will not be synced back.`,
            renameFailed: "Could not move the cloud copy to the new name",
            deleteOutOfScope: "Not inside a managed image folder; SyncHub will not touch it",
        },

        deleteRemote: {
            title: (count: number) =>
                count === 1
                    ? "Also delete this image from the cloud?"
                    : `Also delete these ${count} images from the cloud?`,
            desc:
                "These images still have a backup in the cloud. The local copies are already gone — what " +
                "should happen to the cloud ones?",
            more: (count: number) => `${count} more not listed.`,
            warningHeading: "Cloud deletions cannot be undone",
            warning:
                "The local copies can most likely still be restored from the vault's trash, but the cloud " +
                "has **no trash** — once deleted they are really gone (unless you have a copy elsewhere). " +
                "Choosing \"Keep cloud backup\" leaves the cloud copy in place; it just will not be synced " +
                "back to this device.",
            keep: "Keep cloud backup",
            delete: "Delete cloud backup too",
        },

        plan: {
            heading: "Pending changes",
            empty: "Local and cloud already match — nothing to do.",
            counts: (upload: number, download: number, conflicts: number, skipped: number) =>
                `${upload} to upload, ${download} to download, ${conflicts} conflicted, ${skipped} skipped.`,
            truncated:
                "There are more objects in the cloud than one listing can return, so this run may be " +
                "incomplete: images that were not listed will be treated as missing from the cloud and " +
                "uploaded again. Re-uploading is safe, just wasteful.",
            more: (count: number) => `${count} more not listed.`,
            action: {
                upload: "Upload",
                download: "Download",
                conflict: "Conflict",
                skip: "Skip",
            },
            reason: {
                "local-new": "New locally",
                "local-changed": "Changed locally",
                "remote-new": "New in cloud",
                "remote-changed": "Changed in cloud",
                "local-deleted": "Deleted locally (kept in cloud)",
                conflict: "Changed on both sides",
                "in-sync": "In sync",
            },
        },

        editor: {
            title: (name: string) => `Crop / compress: ${name}`,
            unsupported:
                "This format cannot be re-encoded through a canvas: SVG would be rasterised and GIF would keep " +
                "only the first frame. Convert it to PNG / JPEG / WebP first.",
            readFailed: "Could not read this image.",
            decodeFailed:
                "Could not decode this image — it may be corrupt, or the format is not supported on this platform.",
            format: "Output format",
            formatDesc:
                "Switching format usually changes the size far more than tweaking quality. WebP is typically " +
                "about a quarter smaller than JPEG and supports transparency.",
            quality: "Quality",
            qualityDesc:
                "Only affects lossy formats (JPEG / WebP). PNG is lossless and ignores this.",
            maxEdge: "Longest edge (pixels)",
            maxEdgeDesc: "0 means no scaling. It only shrinks — enlarging a small image just blurs it.",
            ratio: "Lock aspect ratio",
            ratioDesc: "Keep the ratio while dragging the selection.",
            ratioFree: "Free",
            ratioOriginal: "Original ratio",
            ratioSquare: "1:1",
            overwrite: "Overwrite the original",
            overwriteDesc:
                "Turn this off to save as a new file instead (same folder, -edited suffix), leaving the " +
                "original untouched. Overwriting is what most people want — links in notes point at the " +
                "original file, so saving a copy would leave those links showing the old image.",
            targetOverwrite: (path: string) => `Will write back to: ${path}`,
            targetNew: (path: string) => `Will create: ${path}`,
            reset: "Reset selection",
            cancel: "Cancel",
            save: "Save",
            saving: "Saving…",
            summary: (width: number, height: number, size: string, extension: string) =>
                `Output: ${width} × ${height} · ${size} · .${extension}`,
            saveFailed: "Could not save the image",
            saved: (path: string) => `Saved ${path}`,
        },

        manager: {
            title: "Image manager",

            scanning: "Scanning images and references…",
            scanningOf: (done: number, total: number) => `Scanning references… ${done}/${total}`,
            scanFailed: "Could not scan images and references",
            loading: "Scanning…",

            statLocal: "Local",
            statRemote: "Cloud",
            statLinked: "Linked",
            statOrphan: "Orphans",
            statTotal: "Total",
            statLocalBytes: "Local size",

            remoteFailed: (message: string) =>
                `Could not read the cloud listing: ${message}. The "Cloud" column below cannot be trusted.`,
            notConfigured: "Image sync is not configured, so only the local and reference states are shown.",
            truncated: "There are more cloud objects than one listing returns; this view may be incomplete.",

            filterLocal: "Local",
            filterRemote: "Cloud",
            filterLinked: "Linked",
            filterState: {
                any: "Any",
                yes: "Yes",
                no: "No",
            },
            minSize: "Min size",
            minSizeUnit: "KB",
            sort: "Sort",
            sortOption: {
                path: "By path",
                "size-desc": "Largest first",
                "size-asc": "Smallest first",
            },
            search: "Search",
            searchPlaceholder: "Path contains…",

            presetOrphans: "Orphans",
            presetPendingUpload: "To upload",
            presetRemoteOnly: "Cloud only",
            presetLarge: "Large images",
            presetReset: "Reset filters",

            selectAll: "Select all",
            clearSelection: "Clear selection",
            selectedCount: (count: number) => `${count} selected`,
            shown: (visible: number, total: number) => `Showing ${visible} / ${total}`,
            empty: "No images in the managed folders.",
            emptyFiltered: "No images match the current filters.",
            capped: (hidden: number) => `${hidden} more not shown — narrow the filters to see them.`,

            columnPath: "Path",
            columnSize: "Size",
            columnState: "State",
            badgeLocal: "Local",
            badgeRemote: "Cloud",
            badgeLinked: (count: number) => `Linked ×${count}`,
            badgeOrphan: "Unreferenced",

            actionSync: "Sync selected",
            actionCompress: "Compress & sync",
            /** The bottom one — it acts on the whole selection; the row pencil renames one file. */
            actionRename: "Bulk rename",
            /** Label of the pencil button on each row (icon only — this is its meaning). */
            renameThis: "Rename this file",
            /** Label of the row thumbnail — it is the entry point for the full-size preview. */
            previewOpen: "View full size",
            previewZoomIn: "Zoom in",
            previewZoomOut: "Zoom out",
            previewZoomReset: "Reset zoom",
            /** Shown when the image is bigger than the window (drag is the only way to see the rest). */
            previewPannable: "Drag to pan",
            previewPannableHint: "The image is larger than the window — drag to see the rest",
            actionDeleteLocal: "Delete local",
            actionDeleteBoth: "Delete local + cloud",
            noSelection: "Select the images you want to act on first.",
            compressHint: (params: string) =>
                `Compression uses the settings page values (quality / max edge = ${params}), **keeps the ` +
                `original format**, and only writes back when the result is smaller.`,

            syncing: "Syncing the selected images…",
            syncDone: (uploaded: number, downloaded: number, failed: number) =>
                failed > 0
                    ? `Selection synced: ${uploaded} uploaded, ${downloaded} downloaded, ${failed} failed.`
                    : `Selection synced: ${uploaded} uploaded, ${downloaded} downloaded.`,
            syncFailed: "Could not sync the selected images",
            syncFailedMany: (count: number) => `${count} image(s) could not be synced.`,

            compressing: "Compressing…",
            compressingOf: (done: number, total: number) => `Compressing… ${done}/${total}`,
            compressNothing: (skipped: number) =>
                `Nothing was compressed — ${skipped} image(s) either cannot be re-encoded (SVG / GIF) or got larger.`,
            compressDone: (count: number, saved: string, skipped: number) =>
                `Compressed ${count} image(s), saving ${saved}${skipped > 0 ? ` (${skipped} skipped)` : ""}.`,
            compressFailed: (count: number, sample: string) =>
                `${count} image(s) failed to compress, e.g. ${sample}.`,

            renaming: "Renaming…",
            renameTitle: (count: number) => `Rename ${count} image(s)`,
            renameDesc: (placeholders: string) =>
                `Build the new file names from a template. Available placeholders: ${placeholders}. ` +
                `The folder stays the same — Obsidian updates the links in your notes for you.`,
            renameTemplate: "Name template",
            renameStart: "Start number",
            renamePreviewCount: (renameable: number, total: number) =>
                `${renameable} of ${total} selected will be renamed.`,
            renameProblem: {
                unchanged: "name unchanged, skipped",
                invalid: "invalid name, skipped",
                taken: "target exists, skipped",
                extChanged: "extension changed, skipped",
            },
            renameConfirm: (count: number) => `Rename ${count}`,
            renameCancel: "Cancel",
            renameDone: (renamed: number, planned: number) => `Renamed ${renamed} of ${planned}.`,
            renameFailedMany: (count: number, sample: string) =>
                `${count} image(s) could not be renamed, e.g. ${sample}.`,
            renameMissing: "the file is no longer in the vault",

            renameFileTitle: "Rename file",
            renameFileDesc:
                "Only the file name changes; the folder stays the same. Omit the extension to keep the " +
                "current one — links pointing at it in your notes are updated for you.",
            renameFileName: "File name",
            renameFileConfirm: "Rename",
            renameFileDone: (name: string) => `Renamed to ${name}.`,

            deleting: "Deleting…",
            deleteDone: (local: number, remote: number, failed: number) =>
                failed > 0
                    ? `Deleted ${local} local and ${remote} cloud copy/copies; ${failed} failed.`
                    : `Deleted ${local} local and ${remote} cloud copy/copies.`,
            deleteFailed: "Bulk delete failed",
            deleteFailedMany: (count: number, sample: string) =>
                `${count} image(s) could not be deleted, e.g. ${sample}.`,

            confirmLocalTitle: (count: number) => `Delete the local copies of ${count} image(s)?`,
            confirmLocalDesc:
                "The local copies go to the trash (per your \"Settings → Files and links → Deleted files\" choice). " +
                "The cloud copies stay — but they will **not be synced back to this device**: SyncHub records that " +
                "you deleted them, otherwise the next sync would download them again.",
            confirmLocalOk: (count: number) => `Delete ${count} local copy/copies`,

            confirmBothTitle: (count: number) => `Delete ${count} image(s) locally and in the cloud?`,
            confirmBothDesc:
                "The local copies go to the trash and the cloud copies are really deleted. After this, neither side has them.",
            confirmBothWarningHeading: "Cloud deletion cannot be undone",
            confirmBothWarning:
                "The local copies can most likely be restored from the trash, but R2 has **no trash** — once " +
                "deleted they are gone (unless you have another copy elsewhere). Also, any links to them in your " +
                "notes will become broken links.",
            confirmBothOk: (count: number) => `Delete ${count} (including cloud)`,
            confirmCancel: "Cancel",
        },

        errors: {
            notConfigured: (missing: string) =>
                `Image sync is not configured yet; missing: ${missing}. Fill it in on the Image sync settings page.`,
            noFolders:
                "No managed image folder is configured. Add one (for example attachments) on the Image sync settings page.",
            authFailed:
                "R2 rejected the request: the Access Key ID or Secret Access Key is wrong, or the token has no " +
                "permission for this bucket.",
            bucketNotFound: (bucket: string) =>
                `Bucket ${bucket} was not found. Check the name, and whether the token is scoped to it.`,
            listFailed: (status: number, detail: string) =>
                `Listing cloud objects failed (HTTP ${status}): ${detail}`,
            uploadFailed: (path: string, status: number, detail: string) =>
                `Uploading ${path} failed (HTTP ${status}): ${detail}`,
            downloadFailed: (path: string, status: number, detail: string) =>
                `Downloading ${path} failed (HTTP ${status}): ${detail}`,
            deleteFailed: (path: string, status: number, detail: string) =>
                `Deleting ${path} in the cloud failed (HTTP ${status}): ${detail}`,
            network: (detail: string) =>
                `Could not reach R2: ${detail}. Check your network (or proxy) and retry.`,
            localReadFailed: (path: string, detail: string) =>
                `Reading the local file ${path} failed: ${detail}`,
            localWriteFailed: (path: string, detail: string) =>
                `Writing the local file ${path} failed: ${detail}`,
            decodeFailed: (path: string) =>
                `Could not decode ${path} — it may be corrupt, or the format is unsupported on this platform.`,
        },
    },
} satisfies LocaleStrings;
