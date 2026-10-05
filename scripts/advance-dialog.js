import { NAME, DEFAULT_CONFIG, ADVANCE_TYPE, ADVANCE_TYPE_LABELS, SKILL_SOURCE } from "./module-config.js";
import { Utils } from "./utils.js";
import { Advancement } from "./advancement.js";
import { EdgeRequirements } from "./edge-requirements.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class AdvanceDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        tag: "div",
        classes: ["swade-advancement-dialog"],
        window: { title: "SWADE_ADVANCEMENT.AddAdvance", icon: "fa-solid fa-arrow-trend-up" },
        position: { width: 420, height: "auto" },
        actions: {
            add: function (event, button) { this.add(); },
            cancel: function (event, button) { this.close(); },
            clearEdge: function (event, button) { this.clearEdge(); },
        },
    };

    static PARTS = {
        body: {
            template: DEFAULT_CONFIG.templates.advanceDialogBody,
        },
        footer: {
            template: DEFAULT_CONFIG.templates.advanceDialogFooter,
        }
    };

    /**
     * Gets the application id used for the provided actor so that each actor only has one dialog open
     */
    static getId(actor) {
        return `${NAME}-dialog-${actor.uuid.replaceAll(".", "-")}`;
    }

    constructor(options = {}) {
        options.id = AdvanceDialog.getId(options.actor);
        super(options);

        this.actor = options.actor;
        this.advanceType = ADVANCE_TYPE.EDGE;
        this.clearSelections();
    }

    get title() {
        return `${game.i18n.localize(this.options.window.title)}: ${this.actor.name}`;
    }

    clearSelections() {
        this.edge = undefined;
        this.singleSkill = "";
        this.twoSkills = ["", ""];
        this.attribute = "";
        this.hindrance = "";
    }

    async _prepareContext(_options) {
        const advanceSort = Advancement.getNextAdvanceSort(this.actor);
        const advanceTypes = this.getAdvanceTypeOptions();
        if (!advanceTypes.find((t) => t.id == this.advanceType)) {
            this.advanceType = advanceTypes[0].id;
            this.clearSelections();
        }

        const context = {
            advanceTypes: advanceTypes,
            advanceType: this.advanceType,
            rank: game.swade.util.getRankFromAdvanceAsString(advanceSort),
            advanceNumber: advanceSort,
            isEdge: this.advanceType == ADVANCE_TYPE.EDGE,
            isSingleSkill: this.advanceType == ADVANCE_TYPE.SINGLE_SKILL,
            isTwoSkills: this.advanceType == ADVANCE_TYPE.TWO_SKILLS,
            isAttribute: this.advanceType == ADVANCE_TYPE.ATTRIBUTE,
            isHindrance: this.advanceType == ADVANCE_TYPE.HINDRANCE,
            placeholder: game.i18n.localize("SWADE_ADVANCEMENT.SelectPlaceholder"),
            canAdd: false,
            showItemBrowser: !!game.itemBrowser,
        };

        switch (this.advanceType) {
            case ADVANCE_TYPE.EDGE:
                context.dropLabel = game.i18n.localize(this.edge ? "SWADE_ADVANCEMENT.DropEdgeReplace" : "SWADE_ADVANCEMENT.DropEdge");
                if (this.edge) {
                    const check = EdgeRequirements.check(this.actor, this.edge, advanceSort, Advancement.getAdvanceData(this.actor));
                    context.edge = {
                        name: this.edge.name,
                        img: this.edge.img,
                        uuid: this.edge.uuid,
                        requirements: check.requirements,
                    };
                    context.canAdd = check.met;
                }
                break;

            case ADVANCE_TYPE.SINGLE_SKILL:
                context.skillOptions = this.getSingleSkillOptions();
                context.singleSkill = this.singleSkill;
                context.canAdd = !!this.singleSkill;
                break;

            case ADVANCE_TYPE.TWO_SKILLS: {
                const options = await this.getTwoSkillOptions();
                //The same skill can't be selected twice so remove each dropdown's selection from the other dropdown
                context.skillSelects = [0, 1].map((index) => ({
                    index: index,
                    label: game.i18n.localize(index == 0 ? "SWADE_ADVANCEMENT.FirstSkill" : "SWADE_ADVANCEMENT.SecondSkill"),
                    options: options.filter((o) => o.id != this.twoSkills[1 - index]),
                    selected: this.twoSkills[index],
                }));
                context.canAdd = !!this.twoSkills[0] && !!this.twoSkills[1];
                break;
            }

            case ADVANCE_TYPE.ATTRIBUTE:
                context.attributeOptions = this.getAttributeOptions();
                context.attribute = this.attribute;
                context.canAdd = !!this.attribute;
                break;

            case ADVANCE_TYPE.HINDRANCE:
                context.hindranceOptions = this.getHindranceOptions();
                context.hindrance = this.hindrance;
                context.canAdd = !!this.hindrance;
                break;
        }

        return context;
    }

    _onRender(context, options) {
        this.activateListeners();
    }

    activateListeners() {
        const typeSelect = this.element.querySelector("select.advance-type");
        typeSelect?.addEventListener("change", (event) => {
            this.advanceType = Number(event.target.value);
            this.clearSelections();
            this.render();
        });

        for (const select of this.element.querySelectorAll("select[data-selection]")) {
            select.addEventListener("change", (event) => {
                const target = event.target;
                const key = target.dataset.selection;
                if (target.dataset.index !== undefined) {
                    this[key][Number(target.dataset.index)] = target.value;
                } else {
                    this[key] = target.value;
                }
                this.render();
            });
        }

        const body = this.element.querySelector(".advance-dialog-body");
        if (this.advanceType == ADVANCE_TYPE.EDGE && body) {
            const dropZone = body.querySelector(".edge-drop-zone");
            body.addEventListener("dragover", (event) => {
                event.preventDefault();
                dropZone?.classList.add("drag-over");
            });

            body.addEventListener("dragleave", (event) => {
                if (body.contains(event.relatedTarget)) return;
                dropZone?.classList.remove("drag-over");
            });

            body.addEventListener("drop", (event) => {
                dropZone?.classList.remove("drag-over");
                this.onDropEdge(event);
            });

            if (game.itemBrowser) {
                const openBrowserButton = body.querySelector(".open-item-browser-button");
                openBrowserButton.addEventListener("click", async () => {
                    const result = await game.itemBrowser.openBrowser({ itemTypes: ["edge"] });
                    if (result) {
                        const item = await fromUuid(result);
                        if (item?.type !== "edge") {
                            Utils.showNotification("warn", game.i18n.localize("SWADE_ADVANCEMENT.Warnings.NotAnEdge"));
                            return;
                        }

                        this.edge = item;
                        this.render();
                    }
                });
            }
        }
    }

    async onDropEdge(event) {
        event.preventDefault();
        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        if (data?.type != "Item") return;

        const item = await fromUuid(data.uuid);
        if (item?.type !== "edge") {
            Utils.showNotification("warn", game.i18n.localize("SWADE_ADVANCEMENT.Warnings.NotAnEdge"));
            return;
        }

        this.edge = item;
        this.render();
    }

    clearEdge() {
        this.edge = undefined;
        this.render();
    }

    getAdvanceTypeOptions() {
        const hasAttributeAdvance = Advancement.hasAttributeAdvanceThisRank(this.actor);
        return Object.entries(ADVANCE_TYPE_LABELS)
            .filter(([type]) => !(Number(type) == ADVANCE_TYPE.ATTRIBUTE && hasAttributeAdvance))
            .map(([type, label]) => ({ id: Number(type), label: game.i18n.localize(label) }));
    }

    /**
     * Gets the actor's skills along with their unmodified die and the unmodified die of their linked attribute
     */
    getOwnedSkills() {
        return this.actor.items.filter((i) =>   i.type == "skill" &&
                                                !i.name.toLowerCase().includes("unskilled") &&
                                                !i.name.toLowerCase().includes("untrained"))
            .map((skill) => {
                const attribute = skill.system.attribute;
                return {
                    skill: skill,
                    die: Utils.getBaseSkillDie(skill),
                    attributeDie: attribute && this.actor.system.attributes?.[attribute] ? Utils.getBaseAttributeDie(this.actor, attribute) : undefined,
                };
            }
        ).sort((a, b) => a.skill.name.localeCompare(b.skill.name));
    }

    /**
     * Builds a dropdown option showing the change in die type
     */
    static buildDieOption(id, name, currentDie, newDie) {
        const current = currentDie ? Utils.getDieString(currentDie) : game.i18n.localize("SWADE_ADVANCEMENT.Unskilled");
        return { id: id, label: `${name} (${current} to ${Utils.getDieString(newDie)})` };
    }

    /**
     * Skills whose unmodified die is equal to or greater than their linked attribute.
     * Skills without a linked attribute can be raised with either skill advance
     */
    getSingleSkillOptions() {
        return this.getOwnedSkills()
            .filter((s) => !s.attributeDie || s.die.sides >= 12 || s.die.sides >= s.attributeDie.sides)
            .map((s) => AdvanceDialog.buildDieOption(`${SKILL_SOURCE.owned}:${s.skill.id}`, s.skill.name, s.die, Utils.increaseDie(s.die)));
    }

    /**
     * Skills whose unmodified die is below their linked attribute along with all skills the actor does not have
     */
    async getTwoSkillOptions() {
        const owned = this.getOwnedSkills()
            .filter((s) => !s.attributeDie || (s.die.sides < 12 && s.die.sides < s.attributeDie.sides))
            .map((s) => AdvanceDialog.buildDieOption(`${SKILL_SOURCE.owned}:${s.skill.id}`, s.skill.name, s.die, Utils.increaseDie(s.die)))
            .sort((a, b) => a.label.localeCompare(b.label));

        this.unownedSkills ??= await this.getUnownedSkills();
        const unowned = this.unownedSkills
            .map((s) => AdvanceDialog.buildDieOption(`${SKILL_SOURCE.new}:${s.uuid}`, s.name, undefined, { sides: 4, modifier: 0 }))
            .sort((a, b) => a.label.localeCompare(b.label));

        unowned.unshift({ id: "divider", label: "--------------------------------", disabled: true });

        return owned.concat(unowned);
    }

    /**
     * Gathers all skills from the world and compendiums that the actor does not have
     */
    async getUnownedSkills() {
        const ownedSkills = this.actor.items.filter((i) => i.type == "skill");
        const ownedNames = new Set(ownedSkills.map((s) => s.name.toLowerCase()));
        const ownedSwids = new Set(ownedSkills.map((s) => s.system.swid).filter((s) => s));

        let skills = game.items.filter((i) => i.type == "skill").map((i) => ({ uuid: i.uuid, name: i.name, swid: i.system.swid }));

        for (const pack of game.packs) {
            if (pack.documentName != "Item") continue;
            if (!pack.testUserPermission(game.user, "OBSERVER")) continue;

            const index = await pack.getIndex({ fields: ["system.swid"] });
            for (const entry of index) {
                if (entry.type != "skill") continue;
                skills.push({ uuid: entry.uuid, name: entry.name, swid: entry.system?.swid, packId: pack.collection });
            }
        }

        skills = skills.filter((s) => !s.name.toLowerCase().includes("unskilled") && !s.name.toLowerCase().includes("untrained"));
        skills = AdvanceDialog.sortSkills(skills);

        //Remove duplicates, keeping the highest priority version of each skill
        skills = skills.filter((skill, idx, array) => idx == 0 || skill.name.toLowerCase() != array[idx - 1].name.toLowerCase());

        return skills.filter((s) => !ownedNames.has(s.name.toLowerCase()) && !(s.swid && ownedSwids.has(s.swid)));
    }

    /**
     * Sorts skills by name then by the priority of their source
     */
    static sortSkills(skills) {
        const coreSkillsPack = game.settings.get("swade", "coreSkillsCompendium");
        return skills.sort((a, b) => {
            const nameA = a.name.toUpperCase();
            const nameB = b.name.toUpperCase();
            if (nameA != nameB) {
                return nameA < nameB ? -1 : 1;
            }
            return AdvanceDialog.compareSkillSources(a.packId, b.packId, coreSkillsPack);
        });
    }

    /**
     * Compares skill sources so that custom skills are preferred over module skills which are preferred over the system's skills
     */
    static compareSkillSources(a, b, coreSkillsPack) {
        if (a == b) return 0;

        //Skills with no compendium are always the highest since it must be a custom skill
        if (!a) return -1;
        if (!b) return 1;

        //Skills the user's chosen coreSkillsPack are the next highest
        if (a == coreSkillsPack) return -1;
        if (b == coreSkillsPack) return 1;

        //Basic system skills are always the lowest
        if (a == "swade.skills") return 1;
        if (b == "swade.skills") return -1;

        //Skills from the core rules module come next
        if (a == "swade-core-rules.swade-skills") return 1;
        if (b == "swade-core-rules.swade-skills") return -1;

        return a < b ? -1 : 1;
    }

    getAttributeOptions() {
        return Object.keys(CONFIG.SWADE.attributes).map((attribute) => {
            const die = Utils.getBaseAttributeDie(this.actor, attribute);
            return AdvanceDialog.buildDieOption(attribute, Utils.getAttributeName(attribute), die, Utils.increaseDie(die));
        });
    }

    getHindranceOptions() {
        return this.actor.items.filter((i) => i.type == "hindrance")
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((hindrance) => {
                const severity = game.i18n.localize(hindrance.system.isMajor ? "SWADE_ADVANCEMENT.Major" : "SWADE_ADVANCEMENT.Minor");
                return { id: hindrance.id, label: `${hindrance.name} ${severity}` };
            });
    }

    async add() {
        const addButton = this.element.querySelector('[data-action="add"]');
        if (addButton) addButton.disabled = true;

        const selection = {
            edge: this.edge,
            skill: this.singleSkill,
            skills: this.twoSkills,
            attribute: this.attribute,
            hindrance: this.hindrance,
        };

        let added = false;
        try {
            added = await Advancement.addAdvance(this.actor, this.advanceType, selection);
        } catch (error) {
            Utils.consoleMessage("error", { objects: [error], message: "Failed to add advance" });
        }

        if (added) {
            this.close();
        } else {
            Utils.showNotification("error", game.i18n.localize("SWADE_ADVANCEMENT.Warnings.AddFailed"));
            this.render();
        }
    }
}
