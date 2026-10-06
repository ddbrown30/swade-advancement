import { NAME, DEFAULT_CONFIG, ADVANCE_TYPE, ADVANCE_TYPE_LABELS, SKILL_SOURCE } from "./module-config.js";
import { Utils } from "./utils.js";
import { Advancement } from "./advancement.js";
import { AdvanceHistory } from "./advance-history.js";
import { EdgeRequirements } from "./edge-requirements.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class AdvanceDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        tag: "div",
        classes: ["swade-advancement-dialog"],
        window: { title: "SWADE_ADVANCEMENT.AddAdvance", icon: "fa-solid fa-arrow-trend-up" },
        position: { width: 420, height: "auto" },
        actions: {
            submit: function (event, button) { this.submit(); },
            cancel: function (event, button) { this.close(); },
            clearEdge: function (event, button) { this.clearEdge(); },
            toggleDescription: function (event, button) { this.toggleDescription(); },
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
        this.loadAdvance(options.advanceId);
    }

    get title() {
        const key = this.advanceId ? "SWADE_ADVANCEMENT.EditAdvance" : this.options.window.title;
        return `${game.i18n.localize(key)}: ${this.actor.name}`;
    }

    /**
     * The advance being edited or undefined if a new advance is being added
     */
    get advance() {
        return this.advanceId ? this.actor.system.advances.list.get(this.advanceId) : undefined;
    }

    /**
     * Points the dialog at an advance to edit, or at a new advance if no id is provided, and discards any selections
     */
    loadAdvance(advanceId) {
        this.advanceId = advanceId;
        this.advanceType = ADVANCE_TYPE.EDGE;
        this.skillCatalog = undefined;
        this.initial = undefined;
        this.skipIfUnchanged = false;
        this.loadedFrom = undefined;
        this.editingDescription = false;
        this.descriptionDraft = undefined;
        //An advance added after a planned one is planned too unless the user says otherwise
        this.planned = !advanceId && Advancement.isLastAdvancePlanned(this.actor);
        this.clearSelections();
        this.initFromAdvance();
        this.refreshState();
    }

    /**
     * Switches an open dialog to a different advance
     */
    showAdvance(advanceId) {
        this.loadAdvance(advanceId);
        if (this.window?.title) this.window.title.textContent = this.title;
        this.render();
    }

    /**
     * Works out the sort of the advance and the state of the actor before the advance is applied.
     */
    refreshState() {
        this.advanceSort = this.advance?.sort ?? Advancement.getNextAdvanceSort(this.actor);
        this.actorState = Advancement.getActorState(this.actor, this.advanceId, this.planned);
    }

    clearSelections() {
        this.edge = undefined;
        this.singleSkill = "";
        this.twoSkills = ["", ""];
        this.attribute = "";
        this.hindrance = "";
        this.pendingNewSkills = [undefined, undefined];
    }

    /**
     * Gets the dropdown value for a skill stored in an advance's data.
     * Skills the advance added are not on the actor in the state before the advance so they are offered as new skills.
     */
    static getAdvanceSkillValue(skillData) {
        if (!skillData) return "";
        if (skillData.created) return skillData.sourceUuid ? `${SKILL_SOURCE.new}:${skillData.sourceUuid}` : "";
        return `${SKILL_SOURCE.owned}:${skillData.id}`;
    }

    /**
     * Populates the selections from the advance being edited
     */
    initFromAdvance() {
        if (!this.advanceId) return;

        const advance = this.advance;
        if (!advance) {
            this.advanceId = undefined;
            return;
        }

        if (advance.type in ADVANCE_TYPE_LABELS) {
            this.advanceType = Number(advance.type);
        }
        this.planned = !!advance.planned;

        //Advances that weren't created by this module have no stored data. Where possible what they chose is worked out from their description
        const entry = AdvanceHistory.getEntries(this.actor, this.advanceId).find((e) => e.id == this.advanceId);
        const data = entry?.data;
        if (!data) {
            this.prefillFromDescription(entry?.inference?.matched);
            return;
        }

        this.loadedFrom = entry.inferred ? "inferred" : undefined;
        //Saving an advance that was read from its description always goes ahead so that it is stored as though this module created it
        this.skipIfUnchanged = !entry.inferred;
        this.advanceType = data.type;
        switch (data.type) {
            case ADVANCE_TYPE.EDGE:
                //A planned edge isn't on the actor so it comes from the copy stored with the advance
                this.edge = entry.intent?.item ?? this.actor.items.get(data.edgeId);
                break;

            case ADVANCE_TYPE.SINGLE_SKILL:
                //A single skill advance can't create a skill. It only looks like it did if an earlier advance was changed.
                //There is no valid choice to show, so leave it blank
                this.singleSkill = data.skills?.[0]?.created ? "" : AdvanceDialog.getAdvanceSkillValue(data.skills?.[0]);
                break;

            case ADVANCE_TYPE.TWO_SKILLS:
                this.twoSkills = [0, 1].map((i) => AdvanceDialog.getAdvanceSkillValue(data.skills?.[i]));
                //A skill that was added by the advance has no source to select it by if the advance wasn't created by this module. It's found by name later
                this.pendingNewSkills = [0, 1].map((i) => (data.skills?.[i]?.created && !data.skills[i].sourceUuid ? data.skills[i].name : undefined));
                break;

            case ADVANCE_TYPE.ATTRIBUTE:
                this.attribute = data.attribute;
                break;

            case ADVANCE_TYPE.HINDRANCE:
                this.hindrance = data.hindranceId;
                break;
        }

        this.initial = this.getSelection();
    }

    /**
     * Fills in whatever could be matched from the description of an advance that wasn't created by this module, in the case where not everything was matched.
     * Nothing the advance did can be undone in that case so the selections are only a starting point.
     * @param {Object} matched From AdvanceHistory.inferFromNotes()
     */
    prefillFromDescription(matched) {
        if (!matched) return;

        switch (this.advanceType) {
            case ADVANCE_TYPE.EDGE:
                this.edge = this.actor.items.get(matched.edgeId);
                break;
            case ADVANCE_TYPE.SINGLE_SKILL:
                this.singleSkill = matched.skills?.[0] ? `${SKILL_SOURCE.owned}:${matched.skills[0]}` : "";
                break;
            case ADVANCE_TYPE.TWO_SKILLS:
                this.twoSkills = [0, 1].map((i) => (matched.skills?.[i] ? `${SKILL_SOURCE.owned}:${matched.skills[i]}` : ""));
                break;
            case ADVANCE_TYPE.ATTRIBUTE:
                this.attribute = matched.attribute ?? "";
                break;
            case ADVANCE_TYPE.HINDRANCE:
                this.hindrance = matched.hindranceId ?? "";
                break;
        }

        this.loadedFrom = "partial";
        this.initial = this.getSelection();
    }

    /**
     * Gets the current selections as plain data. Used to tell if an edit has changed anything
     */
    getSelection() {
        return {
            type: this.advanceType,
            //The name is included because the edge of a planned advance isn't a real item so it has no uuid of its own
            edge: this.edge ? `${this.edge.uuid}|${this.edge.name}` : "",
            skill: this.singleSkill,
            planned: this.planned,
            plannedLocked: !this.advanceId && Advancement.isLastAdvancePlanned(this.actor),
            skills: [...this.twoSkills],
            attribute: this.attribute,
            hindrance: this.hindrance,
        };
    }

    /**
     * True if editing and the selections are the same as the ones the advance already has
     */
    get isUnchanged() {
        return this.skipIfUnchanged && !!this.initial && JSON.stringify(this.initial) == JSON.stringify(this.getSelection());
    }

    /**
     * Checks if a skill is one of the choices the advance being edited already has.
     * These are always offered, even if the rules would no longer allow them (e.g. a later advance raised the linked attribute),
     * so editing never silently drops an existing choice
     */
    isOriginalSkill(source, id) {
        return !!this.initial && [this.initial.skill, ...this.initial.skills].includes(`${source}:${id}`);
    }

    checkEdge() {
        if (!this.edge) return;
        return EdgeRequirements.check(this.actorState, this.edge, this.advanceSort, AdvanceHistory.getEntries(this.actor), this.advanceId);
    }

    /**
     * Gets the selections in the form the advancement code expects
     */
    getApplySelection() {
        return {
            edge: this.edge,
            skill: this.singleSkill,
            skills: this.twoSkills,
            attribute: this.attribute,
            hindrance: this.hindrance,
        };
    }

    /**
     * True if the description has been changed in the description editor
     */
    get isDescriptionChanged() {
        return this.descriptionDraft !== undefined && this.descriptionDraft !== (this.advance?.notes ?? "");
    }

    /**
     * Switches between the normal view and the editor for the advance's description.
     * The text typed in the editor is kept when switching back but is only ever used when saving from the editor
     */
    toggleDescription() {
        if (!this.advanceId) return;

        this.editingDescription = !this.editingDescription;
        if (this.editingDescription) {
            this.descriptionDraft ??= this.advance?.notes ?? "";
            this.focusDescription = true;
        }
        this.render();
    }

    /**
     * Gets the problems that saving the current selections would cause for the advances after the one being edited. Problems that
     * were already there are not included. Nothing is returned when adding since new advances go at the end
     * @returns {Promise<Array<Object>>} The issues from AdvanceHistory.plan()
     */
    async getIssues() {
        return (await this.getPlan())?.issues ?? [];
    }

    /**
     * Works out what saving the current selections of the advance being edited would change
     * @returns {Promise<Object|undefined>} From AdvanceHistory.plan(). Undefined if nothing would change or it couldn't be worked out
     */
    async getPlan() {
        if (!this.advanceId || this.isUnchanged) return;

        try {
            return await AdvanceHistory.plan(this.actor, {
                kind: "edit",
                advanceId: this.advanceId,
                type: this.advanceType,
                selection: this.getApplySelection(),
                planned: this.planned,
            });
        } catch (error) {
            Utils.consoleMessage("error", { objects: [error], message: "Failed to check the effects of the change" });
        }
    }

    async _prepareContext(_options) {
        //The advance may have been deleted while the dialog was open
        if (this.advanceId && !this.advance) {
            this.loadAdvance(undefined);
        }
        this.refreshState();

        const advanceSort = this.advanceSort;
        const base = {
            rank: game.swade.util.getRankFromAdvanceAsString(advanceSort),
            advanceNumber: advanceSort,
            canEditDescription: !!this.advanceId,
            planned: this.planned,
            plannedLocked: Advancement.hasPlannedBefore(this.actor, this.advanceSort, this.advanceId),
            toggleLabel: game.i18n.localize(this.editingDescription ? "SWADE_ADVANCEMENT.BackToAdvance" : "SWADE_ADVANCEMENT.EditDescription"),
            toggleIcon: this.editingDescription ? "fa-solid fa-arrow-left" : "fa-solid fa-pen",
            submitLabel: game.i18n.localize(this.advanceId ? "SWADE_ADVANCEMENT.Save" : "SWADE_ADVANCEMENT.Add"),
            submitIcon: this.advanceId ? "fa-solid fa-floppy-disk" : "fa-solid fa-plus",
        };

        //The description editor shows nothing else so none of what the normal view needs is worked out
        if (this.editingDescription) {
            return {
                ...base,
                editingDescription: true,
                description: this.descriptionDraft,
                canSubmit: this.isDescriptionChanged,
            };
        }

        const advanceTypes = this.getAdvanceTypeOptions();
        if (!advanceTypes.find((t) => t.id == this.advanceType)) {
            this.advanceType = advanceTypes[0].id;
            this.clearSelections();
        }

        const context = {
            ...base,
            advanceTypes: advanceTypes,
            advanceType: this.advanceType,
            isEdge: this.advanceType == ADVANCE_TYPE.EDGE,
            isSingleSkill: this.advanceType == ADVANCE_TYPE.SINGLE_SKILL,
            isTwoSkills: this.advanceType == ADVANCE_TYPE.TWO_SKILLS,
            isAttribute: this.advanceType == ADVANCE_TYPE.ATTRIBUTE,
            isHindrance: this.advanceType == ADVANCE_TYPE.HINDRANCE,
            placeholder: game.i18n.localize("SWADE_ADVANCEMENT.SelectPlaceholder"),
            canSubmit: false,
            showItemBrowser: !!game.itemBrowser,
        };

        switch (this.advanceType) {
            case ADVANCE_TYPE.EDGE:
                context.dropLabel = game.i18n.localize(this.edge ? "SWADE_ADVANCEMENT.DropEdgeReplace" : "SWADE_ADVANCEMENT.DropEdge");
                if (this.edge) {
                    context.edge = {
                        name: this.edge.name,
                        img: this.edge.img,
                        uuid: this.edge.uuid,
                        groups: this.checkEdge().groups,
                    };
                    context.canSubmit = true;
                }
                break;

            case ADVANCE_TYPE.SINGLE_SKILL:
                context.skillOptions = this.getSingleSkillOptions();
                context.singleSkill = this.singleSkill;
                context.canSubmit = !!this.singleSkill;
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
                context.canSubmit = !!this.twoSkills[0] && !!this.twoSkills[1];
                break;
            }

            case ADVANCE_TYPE.ATTRIBUTE:
                context.attributeOptions = this.getAttributeOptions();
                context.attribute = this.attribute;
                context.canSubmit = !!this.attribute;
                break;

            case ADVANCE_TYPE.HINDRANCE:
                context.hindranceOptions = this.getHindranceOptions();
                context.hindrance = this.hindrance;
                context.canSubmit = !!this.hindrance;
                break;
        }

        //Only shown while the type is still the one that was loaded
        if (this.loadedFrom && this.initial?.type == this.advanceType) {
            context.loadedNote = game.i18n.localize(this.loadedFrom == "inferred" ? "SWADE_ADVANCEMENT.LoadedFromDescription.All" : "SWADE_ADVANCEMENT.LoadedFromDescription.Some");
        }

        if (context.canSubmit) {
            context.warnings = AdvanceHistory.describeIssues(await this.getIssues());
        }

        return context;
    }

    _onRender(context, options) {
        this.activateListeners();
    }

    activateListeners() {
        if (this.editingDescription) {
            const textarea = this.element.querySelector("textarea.advance-description");
            textarea?.addEventListener("input", (event) => {
                //Not rendered again so that the cursor stays where it is. Only the save button needs to follow the text
                this.descriptionDraft = event.target.value;
                const submitButton = this.element.querySelector('[data-action="submit"]');
                if (submitButton) submitButton.disabled = !this.isDescriptionChanged;
            });

            if (this.focusDescription) {
                this.focusDescription = false;
                textarea?.focus();
            }
            return;
        }

        const typeSelect = this.element.querySelector("select.advance-type");
        typeSelect?.addEventListener("change", (event) => {
            this.advanceType = Number(event.target.value);
            this.clearSelections();
            this.render();
        });

        const plannedCheckbox = this.element.querySelector("input.advance-planned");
        plannedCheckbox?.addEventListener("change", (event) => {
            this.planned = event.target.checked;
            //The skills and hindrances to choose from are different if the advances before this one are planned so the selections may not be valid any more
            if (Advancement.hasPlannedBefore(this.actor, this.advanceSort, this.advanceId)) this.clearSelections();
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
        return Object.entries(ADVANCE_TYPE_LABELS)
            .map(([type, label]) => ({ id: Number(type), label: game.i18n.localize(label) }));
    }

    /**
     * Gets the skills the actor had before this advance along with their unmodified die and the unmodified die of their linked attribute
     */
    getOwnedSkills() {
        return this.actorState.skills.filter((s) => !s.name.toLowerCase().includes("unskilled") &&
                                               !s.name.toLowerCase().includes("untrained"))
            .map((skill) => ({
                skill: skill,
                die: skill.die,
                attributeDie: skill.attribute ? this.actorState.attributes[skill.attribute] : undefined,
            }))
            .sort((a, b) => a.skill.name.localeCompare(b.skill.name));
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
            .filter((s) => !s.attributeDie || s.die.sides >= 12 || s.die.sides >= s.attributeDie.sides || this.isOriginalSkill(SKILL_SOURCE.owned, s.skill.id))
            .map((s) => AdvanceDialog.buildDieOption(`${SKILL_SOURCE.owned}:${s.skill.id}`, s.skill.name, s.die, Utils.increaseDie(s.die)));
    }

    /**
     * Skills whose unmodified die is below their linked attribute along with all skills the actor does not have
     */
    async getTwoSkillOptions() {
        const owned = this.getOwnedSkills()
            .filter((s) => !s.attributeDie || (s.die.sides < 12 && s.die.sides < s.attributeDie.sides) || this.isOriginalSkill(SKILL_SOURCE.owned, s.skill.id))
            .map((s) => AdvanceDialog.buildDieOption(`${SKILL_SOURCE.owned}:${s.skill.id}`, s.skill.name, s.die, Utils.increaseDie(s.die)))
            .sort((a, b) => a.label.localeCompare(b.label));

        this.skillCatalog ??= await this.getSkillCatalog();
        const unownedSkills = this.getUnownedSkills(this.skillCatalog);
        this.resolvePendingSkills(unownedSkills);
        const unowned = unownedSkills
            .map((s) => AdvanceDialog.buildDieOption(`${SKILL_SOURCE.new}:${s.uuid}`, s.name, undefined, { sides: 4, modifier: 0 }))
            .sort((a, b) => a.label.localeCompare(b.label));

        unowned.unshift({ id: "divider", label: "--------------------------------", disabled: true });

        return owned.concat(unowned);
    }

    /**
     * Selects the skills that an advance read from its description added, now that the skills that can be added are known
     */
    resolvePendingSkills(unownedSkills) {
        for (const index of [0, 1]) {
            const name = this.pendingNewSkills[index];
            if (!name) continue;
            this.pendingNewSkills[index] = undefined;

            const match = unownedSkills.find((s) => s.name.toLowerCase() == name.toLowerCase());
            if (!match || this.twoSkills[index]) continue;

            this.twoSkills[index] = `${SKILL_SOURCE.new}:${match.uuid}`;
            if (this.initial) this.initial.skills[index] = this.twoSkills[index];
        }
    }

    /**
     * Gathers every skill from the world and compendiums, keeping the highest priority version of each. This doesn't depend on
     * what the actor owns so it is only built once. Which of them are unowned is worked out each time the options are built.
     */
    async getSkillCatalog() {
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

        //Skills added by the advance being edited must be offered from the source they were originally added from. This keeps the existing
        //selection valid even if a different version of the skill would be chosen now
        const data = this.advanceId ? Advancement.getAdvanceData(this.actor)[this.advanceId] : undefined;
        for (const created of (data?.skills ?? []).filter((s) => s.created && s.sourceUuid)) {
            const entry = { uuid: created.sourceUuid, name: created.name, swid: created.swid };
            const index = skills.findIndex((s) => s.name.toLowerCase() == created.name.toLowerCase());
            if (index >= 0) {
                skills[index] = entry;
            } else {
                skills.push(entry);
            }
        }

        return skills;
    }

    /**
     * Filters the skill catalog down to the skills the actor does not have in the state before this advance
     */
    getUnownedSkills(catalog) {
        const ownedSkills = this.actorState.skills;
        const ownedNames = new Set(ownedSkills.map((s) => s.name.toLowerCase()));
        const ownedSwids = new Set(ownedSkills.map((s) => s.swid).filter((s) => s));

        return catalog.filter((s) => !ownedNames.has(s.name.toLowerCase()) && !(s.swid && ownedSwids.has(s.swid)));
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
            const die = this.actorState.attributes[attribute];
            return AdvanceDialog.buildDieOption(attribute, Utils.getAttributeName(attribute), die, Utils.increaseDie(die));
        });
    }

    getHindranceOptions() {
        return this.actorState.hindrances
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((hindrance) => {
                const severity = game.i18n.localize(hindrance.isMajor ? "SWADE_ADVANCEMENT.Major" : "SWADE_ADVANCEMENT.Minor");
                return { id: hindrance.id, label: `${hindrance.name} ${severity}` };
            });
    }

    /**
     * Saves the description from the description editor. Nothing else about the advance or the actor is touched
     */
    async submitDescription() {
        if (!this.isDescriptionChanged) {
            this.close();
            return;
        }

        const submitButton = this.element.querySelector('[data-action="submit"]');
        if (submitButton) submitButton.disabled = true;

        let success = false;
        try {
            success = await Advancement.editDescription(this.actor, this.advanceId, this.descriptionDraft);
        } catch (error) {
            Utils.consoleMessage("error", { objects: [error], message: "Failed to edit description" });
        }

        if (success) {
            this.close();
        } else {
            Utils.showNotification("error", game.i18n.localize("SWADE_ADVANCEMENT.Warnings.DescriptionFailed"));
            this.render();
        }
    }

    async submit() {
        //The description editor saves the description and nothing else. Anything typed in it is ignored when saving from the normal view
        if (this.editingDescription) {
            return this.submitDescription();
        }

        //Nothing to do if an edit didn't change anything. This also avoids needlessly deleting and recreating an edge
        if (this.isUnchanged) {
            this.close();
            return;
        }

        if (this.advanceType === ADVANCE_TYPE.EDGE) {
            if (!this.checkEdge()?.met) {
                const confirmed = await foundry.applications.api.DialogV2.confirm({
                    window: { title: "SWADE_ADVANCEMENT.RequirementsWarning.Title" },
                    content: `<p>${game.i18n.format("SWADE_ADVANCEMENT.RequirementsWarning.Prompt", { name: this.actor.name })}</p>`,
                    rejectClose: false,
                });
                if (!confirmed) return;
            }
        } else if (this.advanceType === ADVANCE_TYPE.ATTRIBUTE) {
            //The advance being edited doesn't count against the once per rank limit
            const hasAttributeAdvance = Advancement.hasAttributeAdvanceThisRank(this.actor, this.advanceSort, this.advanceId);
            if (hasAttributeAdvance) {
                const confirmed = await foundry.applications.api.DialogV2.confirm({
                    window: { title: "SWADE_ADVANCEMENT.AttributeWarning.Title" },
                    content: `<p>${game.i18n.format("SWADE_ADVANCEMENT.AttributeWarning.Prompt", { name: this.actor.name })}</p>`,
                    rejectClose: false,
                });
                if (!confirmed) return;
            }
        }

        //Changing an advance can break the advances after it. The user can still submit if they want
        if (this.advanceId) {
            const plan = await this.getPlan();
            if (plan?.planChanged.length) {
                //Also changes every advance after this one so they are listed along with any problems
                if (!(await Advancement.confirmPlanned(plan, this.planned))) return;
            } else if (plan?.issues.length && !(await Advancement.confirmIssues(plan.issues, "SWADE_ADVANCEMENT.IssuesWarning.EditPrompt"))) {
                return;
            }
        }

        const submitButton = this.element.querySelector('[data-action="submit"]');
        if (submitButton) submitButton.disabled = true;

        const selection = this.getApplySelection();

        const editing = !!this.advanceId;
        let success = false;
        try {
            success = editing
                ? await Advancement.editAdvance(this.actor, this.advanceId, this.advanceType, selection, this.planned)
                : await Advancement.addAdvance(this.actor, this.advanceType, selection, this.planned);
        } catch (error) {
            Utils.consoleMessage("error", { objects: [error], message: editing ? "Failed to edit advance" : "Failed to add advance" });
        }

        if (success) {
            this.close();
        } else {
            Utils.showNotification("error", game.i18n.localize(editing ? "SWADE_ADVANCEMENT.Warnings.EditFailed" : "SWADE_ADVANCEMENT.Warnings.AddFailed"));
            this.render();
        }
    }
}
