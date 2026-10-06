export const NAME = "swade-advancement";

export const TITLE = "SWADE Advancement";
export const SHORT_TITLE = "SA";

export const PATH = "modules/swade-advancement";

export const DEFAULT_CONFIG = {
    templates: {
        advanceDialogBody: `${PATH}/templates/advance-dialog-body.hbs`,
        advanceDialogFooter: `${PATH}/templates/advance-dialog-footer.hbs`,
    },
}

//Mirrors the swade system's ADVANCE_TYPE constant
export const ADVANCE_TYPE = {
    EDGE: 0,
    SINGLE_SKILL: 1,
    TWO_SKILLS: 2,
    ATTRIBUTE: 3,
    HINDRANCE: 4,
}

export const ADVANCE_TYPE_LABELS = {
    [ADVANCE_TYPE.EDGE]: "SWADE.Advances.Types.Edge",
    [ADVANCE_TYPE.SINGLE_SKILL]: "SWADE.Advances.Types.SingleSkill",
    [ADVANCE_TYPE.TWO_SKILLS]: "SWADE.Advances.Types.TwoSkills",
    [ADVANCE_TYPE.ATTRIBUTE]: "SWADE.Advances.Types.Attribute",
    [ADVANCE_TYPE.HINDRANCE]: "SWADE.Advances.Types.Hindrance",
}

//The ways in which a Decrease Hindrance advance can affect a hindrance
export const HINDRANCE_ACTION = {
    removed: "removed",
    reducedToMinor: "reducedToMinor",
    reduced: "reduced",
}

//Prefixes used for the skill dropdown values to distinguish skills the actor owns from ones it does not
export const SKILL_SOURCE = {
    owned: "owned",
    new: "new",
}

export const POWER_POINTS_SWID = "power-points";

export const MULTIPLE_EDGE_SWIDS = [
    "new-powers",
    "trademark-weapon",
    "improved-trademark-weapon",
    "weapon-specialization",
];

export const FLAGS = {
    //Keyed by advance id. Holds the data needed to undo an advance
    advances: "advances",
}

export const SETTING_KEYS = {
}
