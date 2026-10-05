import { Utils } from "./utils.js";
import { registerSettings } from "./settings.js";
import { Advancement } from "./advancement.js";

export class HooksManager {
    /**
     * Registers hooks
     */
    static registerHooks() {

        Hooks.on("init", async () => {
            registerSettings();
            Utils.loadTemplates();
        });

        Hooks.on("setup", async () => {
            Advancement.patchCharacterSheet();
        });
    }
}
