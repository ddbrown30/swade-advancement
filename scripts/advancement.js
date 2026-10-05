import { NAME, FLAGS, ADVANCE_TYPE, HINDRANCE_ACTION, SKILL_SOURCE } from "./module-config.js";
import { Utils } from "./utils.js";
import { AdvanceDialog } from "./advance-dialog.js";

/**
 * Handles applying advances to an actor and undoing them when they are deleted
 */
export class Advancement {

    /**
     * Replaces the character sheet's add and delete advance actions with our own
     */
    static patchCharacterSheet() {
        const sheetClass = game.swade?.sheets?.CharacterSheet;
        if (!sheetClass) {
            Utils.consoleMessage("error", { message: "Unable to find the swade CharacterSheet class. Advancement will not be available." });
            return;
        }

        sheetClass.DEFAULT_OPTIONS.actions.addAdvance = Advancement.onAddAdvanceAction;
        sheetClass.DEFAULT_OPTIONS.actions.deleteAdvance = Advancement.onDeleteAdvanceAction;
    }

    /**
     * Handles the Add Advance button on the character sheet. Called with the sheet as this
     */
    static async onAddAdvanceAction(_event, _target) {
        Advancement.openDialog(this.actor);
    }

    /**
     * Handles the delete advance button on the character sheet. Called with the sheet as this
     */
    static async onDeleteAdvanceAction(_event, target) {
        const id = target.closest("li.advance")?.dataset.advanceId;
        if (!id) return;
        await Advancement.deleteAdvance(this.actor, id);
    }

    /**
     * Opens the advance dialog for the actor or brings an existing one to the front
     */
    static openDialog(actor) {
        const existing = foundry.applications.instances.get(AdvanceDialog.getId(actor));
        if (existing) {
            existing.bringToFront();
            return existing;
        }

        const dialog = new AdvanceDialog({ actor: actor });
        dialog.render(true);
        return dialog;
    }

    /**
     * Gets the stored undo data for all of the actor's advances
     */
    static getAdvanceData(actor) {
        return Utils.getModuleFlag(actor, FLAGS.advances) ?? {};
    }

    /**
     * Gets the sort position the next advance added to the actor will have
     */
    static getNextAdvanceSort(actor) {
        return actor.system.advances.list.size + 1;
    }

    /**
     * Checks if the actor has already taken an attribute advance in the rank of the next advance
     */
    static hasAttributeAdvanceThisRank(actor) {
        const rank = game.swade.util.getRankFromAdvance(Advancement.getNextAdvanceSort(actor));
        return actor.system.advances.list.some((a) => a.type == ADVANCE_TYPE.ATTRIBUTE && game.swade.util.getRankFromAdvance(a.sort) == rank);
    }

    /**
     * Applies the advance to the actor and adds it to the advance list
     * @param {Actor} actor
     * @param {Number} type One of ADVANCE_TYPE
     * @param {Object} selection The choices made in the dialog
     * @returns {Boolean} true if the advance was added
     */
    static async addAdvance(actor, type, selection) {
        let result;
        switch (type) {
            case ADVANCE_TYPE.EDGE:
                result = await Advancement.applyEdge(actor, selection.edge);
                break;
            case ADVANCE_TYPE.SINGLE_SKILL:
                result = await Advancement.applySkills(actor, [selection.skill]);
                break;
            case ADVANCE_TYPE.TWO_SKILLS:
                result = await Advancement.applySkills(actor, selection.skills);
                break;
            case ADVANCE_TYPE.ATTRIBUTE:
                result = await Advancement.applyAttribute(actor, selection.attribute);
                break;
            case ADVANCE_TYPE.HINDRANCE:
                result = await Advancement.applyHindrance(actor, selection.hindrance);
                break;
        }

        if (!result) return false;

        const advances = actor.system.advances.list;
        const newAdvance = {
            id: foundry.utils.randomID(8),
            type: type,
            sort: advances.size + 1,
            planned: false,
            notes: result.notes,
        };
        advances.set(newAdvance.id, newAdvance);

        await actor.update({
            "system.advances.list": advances.toJSON(),
            [`flags.${NAME}.${FLAGS.advances}.${newAdvance.id}`]: result.data,
        });

        return true;
    }

    /**
     * Adds the edge to the actor
     */
    static async applyEdge(actor, edge) {
        const edgeData = edge.toObject();
        delete edgeData._id;
        foundry.utils.setProperty(edgeData, "_stats.compendiumSource", edge.pack ? edge.uuid : edge._stats?.compendiumSource ?? null);

        const [created] = await actor.createEmbeddedDocuments("Item", [edgeData]);
        if (!created) return;

        return {
            notes: edge.name,
            data: {
                edgeId: created.id,
                edgeName: edge.name,
                edgeSwid: edge.system.swid,
            },
        };
    }

    /**
     * Increases each of the selected skills by one step, adding them to the actor if needed
     * @param {Actor} actor
     * @param {Array<String>} selections Skill values from the dialog in the form "owned:<item id>" or "new:<uuid>"
     */
    static async applySkills(actor, selections) {
        const updates = [];
        const toCreate = [];
        const results = [];

        for (const selection of selections) {
            const [source, id] = Advancement.parseSkillValue(selection);
            if (source == SKILL_SOURCE.owned) {
                const skill = actor.items.get(id);
                if (!skill) return;

                const newDie = Utils.increaseDie(Utils.getBaseSkillDie(skill));
                updates.push({ _id: skill.id, "system.die.sides": newDie.sides });
                results.push({ name: skill.name, die: newDie, id: skill.id, created: false });
            } else {
                const skill = await fromUuid(id);
                if (!skill) return;

                const skillData = skill.toObject();
                delete skillData._id;
                foundry.utils.setProperty(skillData, "_stats.compendiumSource", skill.pack ? skill.uuid : skill._stats?.compendiumSource ?? null);
                foundry.utils.setProperty(skillData, "system.die.sides", 4);
                toCreate.push(skillData);
                results.push({ name: skill.name, die: { sides: 4 }, created: true });
            }
        }

        if (updates.length) {
            await actor.updateEmbeddedDocuments("Item", updates);
        }

        if (toCreate.length) {
            const created = await actor.createEmbeddedDocuments("Item", toCreate);
            for (const result of results.filter((r) => r.created)) {
                result.id = created.find((c) => c.name == result.name)?.id;
            }
        }

        return {
            notes: results.map((r) => `${r.name} ${Utils.getDieString(r.die)}`).join(", "),
            data: {
                skills: results.map((r) => ({ id: r.id, name: r.name, created: r.created })),
            },
        };
    }

    /**
     * Increases the selected attribute by one step
     */
    static async applyAttribute(actor, attribute) {
        const newDie = Utils.increaseDie(Utils.getBaseAttributeDie(actor, attribute));
        await actor.update({
            [`system.attributes.${attribute}.die.sides`]: newDie.sides,
            [`system.attributes.${attribute}.die.modifier`]: newDie.modifier,
        });

        return {
            notes: `${Utils.getAttributeName(attribute)} ${Utils.getDieString(newDie)}`,
            data: { attribute: attribute },
        };
    }

    /**
     * Decreases the selected hindrance. Minor hindrances are removed. Major hindrances that have a minor version are reduced to minor.
     * Major hindrances without a minor version require two advances to remove.
     */
    static async applyHindrance(actor, hindranceId) {
        const hindrance = actor.items.get(hindranceId);
        if (!hindrance) return;

        const data = {
            hindranceId: hindrance.id,
            hindranceName: hindrance.name,
        };

        const severity = hindrance.system.severity;
        const formatData = { name: hindrance.name };

        if (!hindrance.system.isMajor) {
            data.action = HINDRANCE_ACTION.removed;
        } else if (severity == "either") {
            data.action = HINDRANCE_ACTION.reducedToMinor;
        } else if (Advancement.hasPreviousHindranceReduction(actor, hindrance)) {
            data.action = HINDRANCE_ACTION.removed;
        } else {
            data.action = HINDRANCE_ACTION.reduced;
        }

        let notes;
        switch (data.action) {
            case HINDRANCE_ACTION.removed:
                data.itemData = hindrance.toObject();
                await hindrance.delete();
                notes = game.i18n.format("SWADE_ADVANCEMENT.Notes.RemovedHindrance", formatData);
                break;
            case HINDRANCE_ACTION.reducedToMinor:
                await hindrance.update({ "system.major": false });
                notes = game.i18n.format("SWADE_ADVANCEMENT.Notes.ReducedHindranceToMinor", formatData);
                break;
            case HINDRANCE_ACTION.reduced:
                notes = game.i18n.format("SWADE_ADVANCEMENT.Notes.ReducedHindrance", formatData);
                break;
        }

        return { notes: notes, data: data };
    }

    /**
     * Checks if the actor has an existing Decrease Hindrance advance that partially reduced this hindrance
     */
    static hasPreviousHindranceReduction(actor, hindrance) {
        const advanceData = Advancement.getAdvanceData(actor);
        return actor.system.advances.list.some((advance) => {
            if (advance.type != ADVANCE_TYPE.HINDRANCE) return false;

            const data = advanceData[advance.id];
            if (data?.action != HINDRANCE_ACTION.reduced) return false;
            return data.hindranceId == hindrance.id || data.hindranceName == hindrance.name;
        });
    }

    /**
     * Splits a skill dropdown value into its source and id
     */
    static parseSkillValue(value) {
        const index = value.indexOf(":");
        return [value.slice(0, index), value.slice(index + 1)];
    }

    /**
     * Asks for confirmation then deletes the advance, undoing any changes it made
     */
    static async deleteAdvance(actor, id) {
        const data = Advancement.getAdvanceData(actor)[id];
        const prompt = game.i18n.localize(data ? "SWADE_ADVANCEMENT.Delete.PromptUndo" : "SWADE_ADVANCEMENT.Delete.Prompt");

        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: "SWADE.Advances.Delete" },
            content: `<p>${prompt}</p>`,
            rejectClose: false,
        });
        if (!confirmed) return;

        const advance = actor.system.advances.list.get(id);
        if (advance && data) {
            const warnings = await Advancement.undoAdvance(actor, advance, data);
            for (const warning of warnings) {
                Utils.showNotification("warn", warning);
            }
        }

        const advances = actor.system.advances.list;
        advances.delete(id);
        const arr = advances.toJSON();
        arr.forEach((a, i) => (a.sort = i + 1));
        await actor.update({ "system.advances.list": arr });

        if (data) {
            await actor.unsetFlag(NAME, `${FLAGS.advances}.${id}`);
        }
    }

    /**
     * Reverts the changes made by an advance
     * @returns {Array<String>} Warnings for any changes that could not be undone
     */
    static async undoAdvance(actor, advance, data) {
        switch (advance.type) {
            case ADVANCE_TYPE.EDGE:
                return Advancement.undoEdge(actor, data);
            case ADVANCE_TYPE.SINGLE_SKILL:
            case ADVANCE_TYPE.TWO_SKILLS:
                return Advancement.undoSkills(actor, data);
            case ADVANCE_TYPE.ATTRIBUTE:
                return Advancement.undoAttribute(actor, data);
            case ADVANCE_TYPE.HINDRANCE:
                return Advancement.undoHindrance(actor, data);
        }
        return [];
    }

    static async undoEdge(actor, data) {
        const edge = actor.items.get(data.edgeId);
        if (!edge) {
            return [game.i18n.format("SWADE_ADVANCEMENT.Undo.MissingItem", { name: data.edgeName })];
        }

        await edge.delete();
        return [];
    }

    static async undoSkills(actor, data) {
        const warnings = [];
        const updates = [];
        const toDelete = [];

        for (const skillData of data.skills ?? []) {
            const skill = actor.items.get(skillData.id);
            if (!skill) {
                warnings.push(game.i18n.format("SWADE_ADVANCEMENT.Undo.MissingItem", { name: skillData.name }));
                continue;
            }

            const die = Utils.getBaseSkillDie(skill);
            if (die.sides <= 4) {
                //We must have added this skill so take it back to unskilled
                toDelete.push(skill.id);
            } else {
                const newDie = Utils.decreaseDie(die);
                updates.push({ _id: skill.id, "system.die.sides": newDie.sides, "system.die.modifier": newDie.modifier });
            }
        }

        if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
        if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
        return warnings;
    }

    static async undoAttribute(actor, data) {
        const newDie = Utils.decreaseDie(Utils.getBaseAttributeDie(actor, data.attribute));
        await actor.update({
            [`system.attributes.${data.attribute}.die.sides`]: newDie.sides,
            [`system.attributes.${data.attribute}.die.modifier`]: newDie.modifier
        });
        return [];
    }

    static async undoHindrance(actor, data) {
        const findHindrance = () => actor.items.get(data.hindranceId) ?? actor.items.find((i) => i.type == "hindrance" && i.name == data.hindranceName);

        switch (data.action) {
            case HINDRANCE_ACTION.removed: {
                if (findHindrance()) {
                    //The hindrance has been added back by some other means so there's nothing to restore
                    return [];
                }
                const itemData = foundry.utils.deepClone(data.itemData);
                delete itemData._id;
                await actor.createEmbeddedDocuments("Item", [itemData]);
                return [];
            }
            case HINDRANCE_ACTION.reducedToMinor: {
                const hindrance = findHindrance();
                if (!hindrance) {
                    return [game.i18n.format("SWADE_ADVANCEMENT.Undo.MissingItem", { name: data.hindranceName })];
                }
                await hindrance.update({ "system.major": true });
                return [];
            }
        }

        //A partial reduction made no changes to the actor so there is nothing to undo
        return [];
    }
}
