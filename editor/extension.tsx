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

    setupTutorialFullToolbox(opts.projectView);
    setupGhSearchFallback();
    setupGitHubRepoFallback();

    return Promise.resolve<pxt.editor.ExtensionResult>(res);
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
        status: 1  // pxt.github.GitRepoStatus.Approved
    };
}
