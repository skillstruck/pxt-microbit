/// <reference path="../node_modules/pxt-core/localtypings/pxtarget.d.ts" />
/// <reference path="../node_modules/pxt-core/built/pxtcompiler.d.ts" />
/// <reference path="../node_modules/pxt-core/built/pxtlib.d.ts" />
/// <reference path="../node_modules/pxt-core/localtypings/pxteditor.d.ts" />
/// <reference path="dapjs.d.ts" />
import * as dialogs from "./dialogs";
import * as flash from "./flash";
import * as patch from "./patch";

pxt.editor.initExtensionsAsync = function (opts: pxt.editor.ExtensionOptions): Promise<pxt.editor.ExtensionResult> {
    pxt.debug('loading microbit target extensions...')

    const manyAny = Math as any;
    if (!manyAny.imul)
        manyAny.imul = function (a: number, b: number): number {
            const ah = (a >>> 16) & 0xffff;
            const al = a & 0xffff;
            const bh = (b >>> 16) & 0xffff;
            const bl = b & 0xffff;
            // the shift by 0 fixes the sign on the high part
            // the final |0 converts the unsigned value into a signed value
            return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) | 0);
        };

    const res: pxt.editor.ExtensionResult = {
        hexFileImporters: []
    };

    pxt.usb.setFilters([{
        vendorId: 0x0D28,
        productId: 0x0204,
        classCode: 0xff,
        subclassCode: 0x03 // the ctrl pipe endpoint
    }, {
        vendorId: 0x0D28,
        productId: 0x0204,
        classCode: 0xff,
        subclassCode: 0x00 // the custom CMSIS2 endpoint
    }])

    res.mkPacketIOWrapper = flash.mkDAPLinkPacketIOWrapper;
    res.blocklyPatch = patch.patchBlocks;
    res.showProgramTooLargeErrorAsync = dialogs.showProgramTooLargeErrorAsync;

    setupCloudApiRoot();
    setupTutorialFullToolbox(opts.projectView);
    setupGhSearchFallback();
    setupGitHubRepoFallback();
    setupGitHubSearchFallback();
    setupGitHubLatestVersionFallback();
    setupGitHubLoadPackageFallback();
    setupGitHubIconFallback();
    setupGitHubDownloadPackageGuard();
    // Fire-and-forget; we don't want to block extension init on cache cleanup.
    purgePoisonedScriptCacheAsync().catch(e => pxt.debug("purgePoisonedScriptCacheAsync failed: " + e));

    return Promise.resolve<pxt.editor.ExtensionResult>(res);
}

// Skill Struck: pxt-core sets `pxt.Cloud.apiRoot` based on host:
//
//   Cloud.apiRoot = isLocalHost() || isNodeJS ? "https://www.makecode.com/api/" : "/api/";
//
// Local `pxt serve` hits Microsoft's upstream proxy directly (full coverage of
// `/api/gh/`, `/api/ghsearch/`, `/api/gh/<repo>/refs/tags`, `/api/gh/<repo>/icon`,
// etc). Hosted deployments hit `/api/` on their own origin — for us, the
// Cloudflare Worker on `roboticseditor.test.skillstruck.com/api/` which only
// covers a subset, hence every workaround in this file.
//
// Override `apiRoot` to point at Microsoft's upstream regardless of host. That
// makes every `/api/...` call match local behavior: real metadata, real tag
// resolution, real icons. The other wraps below still apply as defense in
// depth — if makecode.com is ever unreachable or returns empty, they fall
// back to jsDelivr / synthesis as before. With makecode.com responding
// normally, those fallbacks are no-ops.
//
// The override is idempotent and safe on local: setting apiRoot to the same
// value it already has is a no-op.
function setupCloudApiRoot() {
    const Cloud: any = (pxt as any).Cloud;
    if (!Cloud) return;
    if (Cloud._ssApiRootOverridden) return;
    Cloud._ssApiRootOverridden = true;
    Cloud.apiRoot = "https://www.makecode.com/api/";
}

// Skill Struck: tutorial mode normally sets editorState.filters.blocks from
// the tutorial's usedBlocks set, hiding any toolbox category whose blocks
// aren't referenced in the tutorial markdown — including extensions a student
// just installed. We poll for that filter while a tutorial is active and clear
// it, then force the blocks editor to refresh its toolbox so the new deps
// (e.g. NeoPixel + Sonar) all appear. Step progression and the rest of the
// tutorial UI are unaffected.
function setupTutorialFullToolbox(projectView: pxt.editor.IProjectView) {
    if (!projectView) return;
    const pv = projectView as any;
    if (pv._ssTutorialFullToolboxInterval) return;
    pv._ssTutorialFullToolboxInterval = setInterval(() => {
        try {
            if (typeof pv.isTutorial !== "function" || !pv.isTutorial()) return;
            // Cheap stale-state check so we don't fire setState every tick when
            // there's nothing to clear; the actual update uses the functional
            // form below so it applies against the latest committed state.
            const staleEditorState = pv.state && pv.state.editorState;
            if (!staleEditorState) return;
            const staleFilters = staleEditorState.filters;
            if (!staleFilters || (!staleFilters.blocks && !staleFilters.namespaces)) return;
            pv.setState((prev: any) => {
                const editorState = prev && prev.editorState;
                if (!editorState || !editorState.filters) return null;
                const next = Object.assign({}, editorState);
                delete next.filters;
                return { editorState: next };
            }, () => {
                try {
                    const ed = pv.editor;
                    if (ed && typeof ed.refreshToolbox === "function") {
                        ed.refreshToolbox();
                    } else if (typeof pv.forceUpdate === "function") {
                        pv.forceUpdate();
                    }
                } catch (e) {
                    pxt.debug("refreshToolbox after clear failed: " + e);
                }
            });
        } catch (e) {
            pxt.debug("clearTutorialFilters failed: " + e);
        }
    }, 250);
}

// Skill Struck: the static-pack editor calls `${apiRoot}ghsearch/<target>/<platform>?q=<query>`
// to populate the Extensions panel home view (preferred slugs joined by `|`) and the user-typed
// search results. In production `apiRoot` resolves to `/api/` (pxt.Cloud.apiRoot falls back to
// `/api/` when not on localhost), so the request hits the hosted edge router. That router
// implements `/api/gh/<owner>/<repo>/...` for individual package metadata but NOT
// `/api/ghsearch/`, so the SPA catch-all returns the editor's index.html with HTTP 200. The
// JSON parse fails, the extensions code treats it as empty, and every external approvedRepoLib
// repo (neopixel, sonar, oled, maqueen, cutebot, microturtle, ...) silently vanishes from the
// panel while bundled libs still render.
//
// Patch httpGetJsonAsync to intercept ghsearch URLs: if the real response doesn't come back as
// a usable items array, synthesize one from the already-loaded approvedRepoLib so the panel
// can render tiles. Individual repo metadata still comes through the real /api/gh/ proxy.
function setupGhSearchFallback() {
    const U: any = (pxt as any).U || (pxt as any).Util;
    if (!U || typeof U.httpGetJsonAsync !== "function") return;
    if (U._ssGhSearchPatched) return;
    U._ssGhSearchPatched = true;
    const orig = U.httpGetJsonAsync;
    U.httpGetJsonAsync = function (url: string): Promise<any> {
        if (typeof url !== "string" || !/\/api\/ghsearch\//.test(url)) {
            return orig.call(U, url);
        }
        return orig.call(U, url).then(
            (resp: any) => {
                if (resp && Array.isArray(resp.items)) return resp;
                return synthesizeGhSearchResponse(url);
            },
            () => synthesizeGhSearchResponse(url)
        );
    };
}

function synthesizeGhSearchResponse(url: string): Promise<{ items: any[] }> {
    const m = url.match(/[?&]q=([^&]+)/);
    if (!m) return Promise.resolve({ items: [] });
    let query = "";
    try {
        query = decodeURIComponent(m[1]);
    } catch (e) {
        query = m[1];
    }
    const terms = query.split("|").map(s => s.trim()).filter(Boolean);
    if (!terms.length) return Promise.resolve({ items: [] });
    return (pxt as any).targetConfigAsync().then(
        (cfg: any) => {
            const lib = cfg && cfg.packages && cfg.packages.approvedRepoLib;
            if (!lib) return { items: [] };
            const entries = Object.keys(lib).map(k => ({ slug: k, meta: lib[k] || {} }));
            const matched: { [slug: string]: { slug: string; meta: any } } = {};
            for (const term of terms) {
                const needle = term.toLowerCase();
                const exact = entries.filter(e => e.slug.toLowerCase() === needle)[0];
                if (exact) {
                    matched[exact.slug] = exact;
                    continue;
                }
                for (const e of entries) {
                    const repoPart = (e.slug.split("/")[1] || e.slug).toLowerCase();
                    if (repoPart.indexOf(needle) >= 0) matched[e.slug] = e;
                }
            }
            const items = Object.keys(matched).map(slug => ({
                full_name: slug,
                name: slug.split("/")[1] || slug,
                description: "",
                default_branch: "master",
                private: false,
                fork: false,
                updated_at: new Date(0).toISOString(),
                stargazers_count: 0
            }));
            return { items };
        },
        () => ({ items: [] as any[] })
    );
}

// Skill Struck: pxt.github.searchAsync fast-paths a slug-list query (which is
// what the Extensions home view sends — every preferred slug joined by `|`)
// through pxt.github.repoAsync per slug, NEVER hitting the ghsearch endpoint
// the previous setupGhSearchFallback() handles. repoAsync delegates to a proxy
// at `${apiRoot}gh/<owner>/<repo>`; when that proxy can't answer for a slug
// (404, SPA fallback, missing org, etc.) the helper resolves to undefined and
// the tile silently disappears — that's the home-view symptom on the hosted
// editor even though approvedRepoLib has every kit package.
//
// Patch repoAsync to keep the proxy path as the primary source (so real
// metadata still flows through when available) and only synthesize a minimal
// repo object from approvedRepoLib when the proxy returns nothing.
function setupGitHubRepoFallback() {
    const github: any = (pxt as any).github;
    if (!github || typeof github.repoAsync !== "function") return;
    if (github._ssRepoFallbackPatched) return;
    github._ssRepoFallbackPatched = true;
    const orig = github.repoAsync;
    github.repoAsync = async function (repopath: string, config: any) {
        let result: any;
        try {
            result = await orig.call(github, repopath, config);
        } catch (e) {
            pxt.debug("repoAsync proxy failed for " + repopath + ", falling back: " + e);
            result = undefined;
        }
        if (result) return result;
        return synthesizeRepoFromApprovedLib(repopath, config);
    };
}

function synthesizeRepoFromApprovedLib(repopath: string, config: any): any {
    if (!repopath || !config) return undefined;
    const lib = config.approvedRepoLib;
    if (!lib) return undefined;
    const cleaned = String(repopath).split("#")[0].split("?")[0];
    const parts = cleaned.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    const owner = parts[0];
    const name = parts[1];
    const fullName = owner + "/" + name;
    const needle = fullName.toLowerCase();
    const matched = Object.keys(lib).filter(k => k.toLowerCase() === needle)[0];
    if (!matched) return undefined;
    return {
        github: true,
        owner: owner.toLowerCase(),
        fullName: matched,
        fileName: undefined,
        slug: matched.toLowerCase(),
        name: name,
        description: "",
        defaultBranch: "master",
        tag: undefined,
        status: pxt.github.GitRepoStatus.Approved
    };
}

// Skill Struck: setupGitHubRepoFallback patches the namespace-level
// pxt.github.repoAsync, but pxt.github.searchAsync's body references repoAsync
// via *closure binding* to the local function declaration — not via
// pxt.github.repoAsync. So when the data provider calls
// pxt.github.searchAsync('slug1|slug2|...', packages) for the Extensions panel
// home view, the per-slug repoAsync calls go through the unpatched closure
// reference, return undefined for whatever the hosted proxy can't answer for,
// and the final filter drops them. Result: searchAsync returns 0 items even
// though approvedRepoLib has every preferred slug and the namespace-level
// repoAsync patch correctly returns synthesized objects when called directly.
//
// Wrap pxt.github.searchAsync itself (which the data provider DOES access by
// property lookup) and patch up missing entries from approvedRepoLib after
// the original runs. Slug-list queries (home view) get exact-match synthesis;
// free-text queries (search bar like "neo") get substring-match synthesis
// against repo names. When the original returns valid items (e.g., on local
// dev hitting makecode.com), they pass through unchanged.
function setupGitHubSearchFallback() {
    const github: any = (pxt as any).github;
    if (!github || typeof github.searchAsync !== "function") return;
    if (github._ssSearchFallbackPatched) return;
    github._ssSearchFallbackPatched = true;
    const orig = github.searchAsync;
    github.searchAsync = async function (query: string, config: any) {
        let result: any[] = [];
        let originalError: any = null;
        try {
            const r = await orig.call(github, query, config);
            if (Array.isArray(r)) result = r;
        } catch (e) {
            pxt.debug("searchAsync original failed, attempting fallback: " + e);
            originalError = e;
        }
        // No fallback data available — preserve the original promise outcome
        // so the data provider's .catch(handleNetworkError) still fires.
        if (!query || !config || !config.approvedRepoLib) {
            if (originalError) throw originalError;
            return result;
        }

        const lib = config.approvedRepoLib;
        const libSlugs = Object.keys(lib);
        const terms = String(query).split("|").map(s => s.trim()).filter(Boolean);

        // Index whatever the original returned so we can prefer its richer
        // metadata over a synthesized stub when both are available for the
        // same slug.
        const bySlug: { [k: string]: any } = {};
        for (const r of result) {
            if (r && r.fullName) bySlug[String(r.fullName).toLowerCase()] = r;
        }

        // Build the final array in query/terms order rather than mutating the
        // original in place — keeps curated-tile sequence intact for partial
        // upstream hits.
        const ordered: any[] = [];
        const seen: { [k: string]: boolean } = {};
        const emit = (repo: any) => {
            if (!repo || !repo.fullName) return;
            const key = String(repo.fullName).toLowerCase();
            if (seen[key]) return;
            ordered.push(repo);
            seen[key] = true;
        };

        for (const term of terms) {
            const synth = synthesizeRepoFromApprovedLib(term, config);
            if (synth) {
                const key = String(synth.fullName).toLowerCase();
                emit(bySlug[key] || synth);
                continue;
            }
            // Free-text term — substring-match against the repo half of each
            // approved slug, emitting matches for this term before moving on.
            const needle = term.toLowerCase();
            for (const slug of libSlugs) {
                const key = slug.toLowerCase();
                if (seen[key]) continue;
                const repoPart = (slug.split("/")[1] || slug).toLowerCase();
                if (repoPart.indexOf(needle) >= 0) {
                    emit(bySlug[key] || synthesizeRepoFromApprovedLib(slug, config));
                }
            }
        }
        // Defensive: surface any original results not requested via terms so
        // we never strictly subtract from the upstream response.
        for (const r of result) emit(r);

        if (!ordered.length && originalError) throw originalError;
        return ordered;
    };
}

// Skill Struck: install of an external extension calls
// pxt.github.db.loadPackageAsync, which first tries the hosted proxy via
// proxyWithCdnLoadPackageAsync (`/api/gh/<owner>/<repo>/<tag>/text`). When
// the proxy returns nothing for a slug it does NOT throw — it resolves with
// `{ files: undefined }`, the outer loadPackageAsync's catch never fires,
// the malformed value gets cached, and downstream `Object.keys(undefined)`
// in MakeCode's setFiles crashes the install with:
//
//   TypeError: Cannot convert undefined or null to object
//     at Object.keys → n.mapMap → h.setFiles → MainPackage.loadAsync
//
// Skill Struck: pxt.github.latestVersionAsync resolves an unpinned
// `github:owner/repo` URL into a specific tag by calling listRefsExtAsync
// against the proxy. On hosted, that endpoint returns empty/404 for the
// repos the proxy can't serve (e.g., microsoft/*), so latestVersionAsync
// resolves to undefined. Callers then template-stringify into
// `repoWithTag = "owner/repo#" + undefined`, producing "owner/repo#undefined"
// which propagates downstream — and was the @undefined we saw in the
// jsDelivr URL during testing.
//
// Wrap latestVersionAsync to give a usable answer when the underlying ref
// listing can't: prefer the original's result, otherwise consult
// config.releases.v<major> for a per-repo pin, otherwise fall back to
// "master". Same defensive pattern as the other wraps — pass-through when
// real data is available, synthesize when it isn't.
function setupGitHubLatestVersionFallback() {
    const github: any = (pxt as any).github;
    if (!github || typeof github.latestVersionAsync !== "function") return;
    if (github._ssLatestVersionPatched) return;
    github._ssLatestVersionPatched = true;
    const orig = github.latestVersionAsync;
    github.latestVersionAsync = async function (repopath: string, config: any, useProxy?: boolean, noCache?: boolean) {
        let result: any;
        try {
            result = await orig.call(github, repopath, config, useProxy, noCache);
        } catch (e) {
            pxt.debug("latestVersionAsync original failed for " + repopath + ": " + e);
        }
        if (result && typeof result === "string" && result !== "undefined" && result !== "null") {
            return result;
        }
        const parsed = github.parseRepoId(repopath);
        if (parsed && config) {
            const targetVer = (pxt as any).appTarget && (pxt as any).appTarget.versions && (pxt as any).appTarget.versions.target;
            const major = typeof targetVer === "string" ? targetVer.split(".")[0] : "";
            const releaseList = major && config.releases && config.releases["v" + major];
            if (Array.isArray(releaseList)) {
                for (const releaseStr of releaseList) {
                    const release = github.parseRepoId(releaseStr);
                    if (release && release.fullName && parsed.fullName
                        && release.fullName.toLowerCase() === parsed.fullName.toLowerCase()
                        && release.tag) {
                        pxt.debug(`latestVersionAsync fallback: pinned ${parsed.fullName} to ${release.tag} (releases.v${major})`);
                        return release.tag;
                    }
                }
            }
        }
        pxt.debug(`latestVersionAsync fallback: no tag found for ${repopath}, defaulting to master`);
        return "master";
    };
}

// Wrap proxyWithCdnLoadPackageAsync: if the proxy returns something
// missing or empty, fall back to fetching files directly from jsDelivr's
// GitHub CDN (cdn.jsdelivr.net/gh/<owner>/<repo>@<tag>/<file>), which
// proxies raw.githubusercontent.com without rate limits and is allowed
// under most CSP/COEP configurations. The proxy's real response still
// wins when it works, so working repos stay untouched.
function setupGitHubLoadPackageFallback() {
    const github: any = (pxt as any).github;
    if (!github) return;
    // pxt.github.db is initialized lazily by the workspace; if it's not on the
    // namespace yet at initExtensionsAsync time we'd silently no-op and the
    // wrap would never install. Retry on a short interval until db.proxyWithCdnLoadPackageAsync
    // exists, then install the wrap exactly once.
    if (github._ssLoadPkgRetrying) return;
    github._ssLoadPkgRetrying = true;
    let attempts = 0;
    const tryInstall = () => {
        if (github.db && typeof github.db.proxyWithCdnLoadPackageAsync === "function" && !github.db._ssLoadPkgPatched) {
            installLoadPackageWrap(github.db);
            github._ssLoadPkgRetrying = false;
            return;
        }
        if (++attempts > 200) { // ~50s @ 250ms
            pxt.debug("setupGitHubLoadPackageFallback: gave up waiting for github.db");
            github._ssLoadPkgRetrying = false;
            return;
        }
        setTimeout(tryInstall, 250);
    };
    tryInstall();
}

function installLoadPackageWrap(db: any) {
    db._ssLoadPkgPatched = true;
    const orig = db.proxyWithCdnLoadPackageAsync.bind(db);
    db.proxyWithCdnLoadPackageAsync = async function (repopath: string, tag: string) {
        let result: any;
        try {
            result = await orig(repopath, tag);
        } catch (e) {
            pxt.debug("proxyWithCdnLoadPackageAsync failed for " + repopath + "@" + tag + ", falling back: " + e);
            result = undefined;
        }
        if (result && result.files && typeof result.files === "object" && Object.keys(result.files).length > 0) {
            return result;
        }
        pxt.debug("proxy returned empty package for " + repopath + "@" + tag + ", fetching from jsDelivr");
        return fetchPackageFromJsDelivr(repopath, tag);
    };
}

// Skill Struck: Extensions panel tiles compute <img src=…> via
// pxt.github.repoIconUrl(repo), which by default routes through
// `${cdnApiUrl}/gh/<owner>/<repo>/icon`. The hosted proxy doesn't serve that
// endpoint for the repos it can't proxy, so every external tile renders with
// Chrome's broken-image placeholder.
//
// First attempt patched pxt.github.mkRepoIconUrl, but pxt-core's repoIconUrl
// references mkRepoIconUrl via closure binding (the local function declared
// in the same scope) — same pattern that bit searchAsync vs repoAsync.
// Namespace property override doesn't intercept closure-bound calls. Wrap
// pxt.github.repoIconUrl itself (which IS what callers like the Extensions
// panel access via property lookup) and synthesize a jsDelivr URL directly.
// Image src is synchronous so there's no clean "try proxy first, fall back"
// pattern — we just always go to jsDelivr, which serves any public GitHub
// file with no rate limits.
function setupGitHubIconFallback() {
    const github: any = (pxt as any).github;
    if (!github || typeof github.repoIconUrl !== "function") return;
    if (github._ssIconPatched) return;
    github._ssIconPatched = true;
    // Also override mkRepoIconUrl on the namespace for any consumer that
    // somehow accesses it via property lookup; harmless if nothing does.
    github.mkRepoIconUrl = buildJsDelivrIconUrl;
    github.repoIconUrl = function (repo: any) {
        if (!repo || !repo.fullName) return undefined;
        // Approval check is still enforced — same as the original.
        const ApprovedStatus = github.GitRepoStatus && github.GitRepoStatus.Approved;
        if (ApprovedStatus != null && repo.status !== ApprovedStatus) return undefined;
        return buildJsDelivrIconUrl(repo);
    };
}

function buildJsDelivrIconUrl(repo: any): string | undefined {
    if (!repo || !repo.fullName) return undefined;
    const ref = repo.tag || repo.defaultBranch || "master";
    return `https://cdn.jsdelivr.net/gh/${repo.fullName}@${ref}/icon.png`;
}

async function fetchPackageFromJsDelivr(repopath: string, tag: string): Promise<{ files: { [k: string]: string } }> {
    const ref = tag || "master";
    const slug = String(repopath);
    const base = `https://cdn.jsdelivr.net/gh/${slug}@${ref}`;
    const configName = (pxt as any).CONFIG_NAME || "pxt.json";

    // 1. Fetch pxt.json to learn which files this package ships.
    const configResp = await fetch(`${base}/${configName}`);
    if (!configResp.ok) {
        throw new Error(`jsDelivr ${configName} fetch failed for ${slug}@${ref}: HTTP ${configResp.status}`);
    }
    const configText = await configResp.text();
    let parsed: any;
    try {
        parsed = JSON.parse(configText);
    } catch (e) {
        throw new Error(`jsDelivr ${configName} parse failed for ${slug}@${ref}: ${e}`);
    }

    // 2. Fetch each declared file (and testFiles, since MakeCode reads both).
    const declared: string[] = [];
    if (Array.isArray(parsed.files)) declared.push(...parsed.files);
    if (Array.isArray(parsed.testFiles)) declared.push(...parsed.testFiles);

    const files: { [k: string]: string } = { [configName]: configText };
    const missing: string[] = [];
    await Promise.all(declared.map(async (name) => {
        if (files[name]) return; // already have it (configName, dedupe)
        try {
            const r = await fetch(`${base}/${encodeURI(name)}`);
            if (r.ok) files[name] = await r.text();
            else {
                pxt.debug(`jsDelivr file ${name} HTTP ${r.status} for ${slug}@${ref}`);
                missing.push(`${name} (HTTP ${r.status})`);
            }
        } catch (e) {
            pxt.debug(`jsDelivr file ${name} fetch failed for ${slug}@${ref}: ${e}`);
            missing.push(`${name} (${e})`);
        }
    }));
    // Fail closed on partial fetches so getPublishedScriptAsync's catch path
    // skips caching this truncated result. Returning a partial map here would
    // poison the IndexedDB script cache and re-create the bug this PR fixes.
    if (missing.length) {
        throw new Error(`jsDelivr partial fetch for ${slug}@${ref}: missing ${missing.join(", ")}`);
    }
    return { files };
}

// Skill Struck: pxt.github.downloadPackageAsync's return value flows into
// getPublishedScriptAsync, which caches `result.files` into IndexedDB
// (SCRIPT_TABLE) under the upgraded package id. When earlier install
// attempts hit the broken hosted proxy *before* our fallback shipped,
// the result was `{ files: undefined }` — and the workspace happily wrote
// `files: undefined` to IndexedDB. Subsequent install clicks then hit the
// cache, return undefined files, and crash in setFiles -> Object.keys.
//
// Wrap downloadPackageAsync to throw when the underlying loadPackageAsync
// resolves with an empty/missing files map. A throw skips the cache write
// in getPublishedScriptAsync's catch block, so future failed downloads
// stop poisoning the cache. Combined with the IndexedDB purge below,
// this prevents the bug from recurring and recovers users already stuck
// from previous failed attempts.
function setupGitHubDownloadPackageGuard() {
    const github: any = (pxt as any).github;
    if (!github || typeof github.downloadPackageAsync !== "function") return;
    if (github._ssDownloadGuardPatched) return;
    github._ssDownloadGuardPatched = true;
    const orig = github.downloadPackageAsync;
    github.downloadPackageAsync = async function (repoWithTag: string, config: any) {
        const result = await orig.call(github, repoWithTag, config);
        if (result && result.files && typeof result.files === "object" && Object.keys(result.files).length > 0) {
            return result;
        }
        // Empty result. Try jsDelivr directly so we still install successfully.
        pxt.debug("downloadPackageAsync empty for " + repoWithTag + ", refetching via jsDelivr");
        const p: any = github.parseRepoId(repoWithTag);
        if (!p) throw new Error("ss-guard: cannot parse repo id " + repoWithTag);
        // parseRepoId can return the literal strings "undefined"/"null" as the
        // tag when an upstream template-stringified an undefined into the URL
        // (e.g. `${repo.fullName}#${tag}` with tag === undefined). Treat those
        // as no-tag and resolve via our latestVersionAsync wrap (which honors
        // releases.v<major>) or fall back to master.
        const rawTag = p.tag && p.tag !== "undefined" && p.tag !== "null" ? p.tag : undefined;
        let tag: any = rawTag;
        if (!tag && github.latestVersionAsync) {
            try { tag = await github.latestVersionAsync(p.slug, config); } catch { }
        }
        if ((!tag || tag === "undefined" || tag === "null") && github.db && github.db.latestVersionAsync) {
            try { tag = await github.db.latestVersionAsync(p.slug, config); } catch { }
        }
        if (!tag || tag === "undefined" || tag === "null") tag = "master";
        return fetchPackageFromJsDelivr(p.fullName, tag);
    };
}

// Skill Struck: scan IndexedDB on init and delete script-cache entries
// whose `files` is missing or empty. Such entries are leftover poison from
// installs that ran against the broken proxy before the fallback shipped.
// One-time cleanup per page load; on subsequent loads the cache is clean
// and we're a no-op.
async function purgePoisonedScriptCacheAsync(): Promise<void> {
    if (typeof indexedDB === "undefined" || !(indexedDB as any).databases) return;
    let dbInfos: { name?: string }[];
    try {
        dbInfos = await (indexedDB as any).databases();
    } catch (e) {
        pxt.debug("indexedDB.databases() failed: " + e);
        return;
    }
    // Scope the purge to databases that look PXT-owned. pxt-core's workspace
    // DB co-locates "script" with a fixed set of other stores ("texts",
    // "headers", "github", "hostcache"); a same-origin IndexedDB that happens
    // to have a "script" store but none of these companions is not ours and
    // we leave it alone.
    const PXT_COMPANION_STORES = ["texts", "headers", "github", "hostcache"];
    for (const info of dbInfos) {
        if (!info.name) continue;
        await new Promise<void>((resolve) => {
            const openReq = indexedDB.open(info.name!);
            openReq.onsuccess = () => {
                const db = openReq.result;
                if (!db.objectStoreNames.contains("script")) {
                    db.close();
                    resolve();
                    return;
                }
                const hasPxtCompanion = PXT_COMPANION_STORES.some(s => db.objectStoreNames.contains(s));
                if (!hasPxtCompanion) {
                    pxt.debug(`skipping non-PXT db with 'script' store: ${info.name}`);
                    db.close();
                    resolve();
                    return;
                }
                let tx: IDBTransaction;
                try {
                    tx = db.transaction("script", "readwrite");
                } catch (e) {
                    db.close();
                    resolve();
                    return;
                }
                const store = tx.objectStore("script");
                const cursorReq = store.openCursor();
                let purged = 0;
                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (cursor) {
                        const value = cursor.value;
                        const files = value && value.files;
                        const isEmpty = !files
                            || typeof files !== "object"
                            || Object.keys(files).length === 0;
                        if (isEmpty) {
                            cursor.delete();
                            purged++;
                        }
                        cursor.continue();
                    } else {
                        if (purged > 0) pxt.debug(`purged ${purged} poisoned script-cache entries from ${info.name}`);
                        db.close();
                        resolve();
                    }
                };
                cursorReq.onerror = () => { db.close(); resolve(); };
                tx.onerror = () => { try { db.close(); } catch { } resolve(); };
            };
            openReq.onerror = () => resolve();
            openReq.onblocked = () => resolve();
        });
    }
}
