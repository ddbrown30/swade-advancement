import { ADVANCE_TYPE, HINDRANCE_ACTION } from "./module-config.js";
import { Utils } from "./utils.js";

/**
 * A lightweight snapshot of the parts of an actor
 *
 * The snapshot can be rewound so that it shows the actor as it was before a given advance was applied. This lets the
 * advance dialog build its options and check edge requirements for an advance that is being edited without that advance's own
 * changes getting in the way (e.g. its attribute raise, its new skill or its edge).
 */
export class ActorState {

    constructor(actor) {
        this.actor = actor;
        this.isWildcard = actor.isWildcard;

        this.attributes = {};
        for (const attribute of Object.keys(CONFIG.SWADE.attributes)) {
            this.attributes[attribute] = foundry.utils.deepClone(Utils.getBaseAttributeDie(actor, attribute));
        }

        this.items = actor.items.map((item) => ({
            id: item.id,
            type: item.type,
            name: item.name,
            swid: item.system.swid,
            item: item,
            die: item.type == "skill" ? foundry.utils.deepClone(Utils.getBaseSkillDie(item)) : undefined,
            attribute: item.type == "skill" ? item.system.attribute : undefined,
            isMajor: item.type == "hindrance" ? item.system.isMajor : undefined,
            severity: item.type == "hindrance" ? item.system.severity : undefined,
        }));
    }

    /**
     * Makes an independent copy so that it can be changed without affecting this snapshot
     */
    clone() {
        const copy = Object.create(ActorState.prototype);
        copy.actor = this.actor;
        copy.isWildcard = this.isWildcard;
        copy.attributes = foundry.utils.deepClone(this.attributes);
        copy.items = this.items.map((i) => ({ ...i, die: i.die ? { ...i.die } : undefined }));
        return copy;
    }

    /**
     * Finds a skill by its swid or its name
     */
    findSkill(name, swid) {
        const lower = name?.toLowerCase();
        return this.skills.find((s) => (swid && s.swid && s.swid == swid) || s.name.toLowerCase() == lower);
    }

    /**
     * Finds a hindrance by its id or failing that its name
     */
    findHindrance(id, name) {
        return this.hindrances.find((h) => h.id == id) ?? this.hindrances.find((h) => name && h.name == name);
    }

    /**
     * Gets the data needed to recreate a hindrance in the state it is in now
     */
    static getHindranceItemData(record) {
        const itemData = foundry.utils.deepClone(record.itemData ?? record.item.toObject());
        foundry.utils.setProperty(itemData, "system.major", !!record.isMajor);
        return itemData;
    }

    get skills() {
        return this.items.filter((i) => i.type == "skill");
    }

    get hindrances() {
        return this.items.filter((i) => i.type == "hindrance");
    }

    /**
     * Decides what undoing an advance does to one of the skills it raised. This is shared by the real undo and by rewind() so
     * that they can never disagree.
     * @param {Object} skillData One of the entries in an advance's stored skills
     * @param {Object} die The skill's current unmodified die
     * @returns {Object|null} The die the skill goes back to or null if the skill was added by the advance and should be removed
     */
    static getUndoneSkillDie(skillData, die) {
        if (skillData.created && die.sides <= 4) return null;
        return Utils.decreaseDie(die);
    }

    /**
     * Rewinds the snapshot to before the advance described by the stored undo data was applied
     * @param {Object} data An advance's stored undo data
     */
    rewind(data) {
        switch (data.type) {
            case ADVANCE_TYPE.EDGE:
                this.items = this.items.filter((i) => i.id != data.edgeId);
                break;

            case ADVANCE_TYPE.SINGLE_SKILL:
            case ADVANCE_TYPE.TWO_SKILLS:
                for (const skillData of data.skills ?? []) {
                    const skill = this.items.find((i) => i.type == "skill" && i.id == skillData.id);
                    if (!skill) continue;

                    const newDie = ActorState.getUndoneSkillDie(skillData, skill.die);
                    if (newDie) {
                        skill.die = newDie;
                    } else {
                        this.items = this.items.filter((i) => i !== skill);
                    }
                }
                break;

            case ADVANCE_TYPE.ATTRIBUTE:
                if (this.attributes[data.attribute]) {
                    this.attributes[data.attribute] = Utils.decreaseDie(this.attributes[data.attribute]);
                }
                break;

            case ADVANCE_TYPE.HINDRANCE:
                this.rewindHindrance(data);
                break;
        }
    }

    rewindHindrance(data) {
        const existing = this.hindrances.find((i) => i.id == data.hindranceId || i.name == data.hindranceName);

        switch (data.action) {
            case HINDRANCE_ACTION.removed:
                if (existing || !data.itemData) return;

                //Use a temporary item so that derived values like isMajor are worked out by the system
                const item = new CONFIG.Item.documentClass(foundry.utils.deepClone(data.itemData));
                this.items.push({
                    id: data.hindranceId,
                    type: "hindrance",
                    name: item.name,
                    swid: item.system.swid,
                    item: item,
                    isMajor: item.system.isMajor,
                    severity: item.system.severity,
                    itemData: foundry.utils.deepClone(data.itemData),
                });
                break;

            case HINDRANCE_ACTION.reducedToMinor:
                if (existing) existing.isMajor = true;
                break;
        }

        //A partial reduction made no changes to the actor so there is nothing to rewind
    }
}
