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
