import { NAME, TITLE, SHORT_TITLE, DEFAULT_CONFIG } from "./module-config.js";

/**
 * Provides helper methods for use elsewhere in the module
 */
export class Utils {

    /**
     * Get a single setting using the provided key
     */
    static getSetting(key) {
        return game.settings.get(NAME, key);
    }

    /**
     * Sets a single game setting
     */
    static async setSetting(key, value) {
        return game.settings.set(NAME, key, value);
    }

    /**
     * Register a single setting using the provided key and setting data
     */
    static registerSetting(key, metadata) {
        return game.settings.register(NAME, key, metadata);
    }

    /**
     * Loads the module's templates so they are cached
     */
    static async loadTemplates() {
        await foundry.applications.handlebars.loadTemplates(Object.values(DEFAULT_CONFIG.templates));
    }

    /**
     * Displays a UI notification prefixed with the module's short title
     */
    static showNotification(type, message, options) {
        const msg = `${SHORT_TITLE} | ${message}`;
        return ui.notifications[type](msg, options);
    }

    /**
     * Formats and writes a message to the console
     */
    static consoleMessage(type, {objects=[], message="", subStr=[]}) {
        const msg = `${TITLE} | ${message}`;
        const params = [];
        if (objects && objects.length) params.push(objects);
        if (msg) params.push(msg);
        if (subStr && subStr.length) params.push(subStr);
        return console[type](...params);
    }

    /**
     * Checks if the provided object has any flags belonging to this module
     */
    static hasModuleFlags(obj) {
        if (!obj.flags) {
            return false;
        }

        return obj.flags[NAME] ? true : false;
    }

    /**
     * Gets the corresponding flag value from this module's scope
     */
    static getModuleFlag(obj, flag) {
        if (!Utils.hasModuleFlags(obj)) {
            return;
        }

        return obj.flags[NAME][flag];
    }

    /**
     * Returns a copy of the die normalized so that anything above a d12 is expressed as a d12 plus a modifier
     */
    static normalizeDie(die) {
        let sides = die?.sides ?? 4;
        let modifier = die?.modifier ?? 0;
        if (sides > 12) {
            modifier += (sides - 12) / 2;
            sides = 12;
        }
        return { sides: sides, modifier: modifier };
    }

    /**
     * Returns the die one step above the provided die. Going above a d12 results in d12+1, d12+2, etc.
     */
    static increaseDie(die) {
        const newDie = { ...die };
        newDie.sides += 2;
        return newDie;
    }

    /**
     * Returns the die one step below the provided die. Will not go below a d4
     */
    static decreaseDie(die) {
        const newDie = { ...die };
        if (newDie.sides >= 12 && newDie.modifier > 0) {
            newDie.modifier -= 1;
        } else {
            newDie.sides = Math.max(4, newDie.sides - 2);
        }
        return newDie;
    }

    /**
     * Returns the display string for a die e.g. d8 or d12+1
     */
    static getDieString(die) {
        const normalized = Utils.normalizeDie(die);
        let dieString = `d${normalized.sides}`;
        if (normalized.modifier > 0) {
            dieString += `+${normalized.modifier}`;
        } else if (normalized.modifier < 0) {
            dieString += `${normalized.modifier}`;
        }
        return dieString;
    }

    /**
     * Gets the unmodified die for the given attribute on the actor
     */
    static getBaseAttributeDie(actor, attribute) {
        return foundry.utils.getProperty(actor._source, `system.attributes.${attribute}.die`);
    }

    /**
     * Gets the unmodified die for the given skill
     */
    static getBaseSkillDie(skill) {
        return foundry.utils.getProperty(skill._source, "system.die");
    }

    /**
     * Gets the data needed to create a copy of an edge on an actor. This is also what is stored with a planned edge advance
     * so the edge can be added later without needing the original item
     * @param {Item} edge
     */
    static getEdgeData(edge) {
        const edgeData = edge.toObject();
        delete edgeData._id;
        foundry.utils.setProperty(edgeData, "_stats.compendiumSource", edge.pack ? edge.uuid : edge._stats?.compendiumSource ?? null);
        return edgeData;
    }

    /**
     * Gets the localized name of an attribute
     */
    static getAttributeName(attribute) {
        const label = CONFIG.SWADE.attributes[attribute]?.long;
        return label ? game.i18n.localize(label) : attribute;
    }

    /**
     * Escapes the provided text so it can be put in html
     */
    static escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text ?? "";
        return div.innerHTML;
    }

    /**
     * Escapes the provided text so that it can be used literally in a regular expression
     */
    static escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /**
     * Strips any html from the provided string
     */
    static stripHtml(html) {
        const div = document.createElement("div");
        div.innerHTML = html ?? "";
        return div.textContent ?? "";
    }
}
