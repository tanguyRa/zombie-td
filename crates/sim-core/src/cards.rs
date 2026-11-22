//! Card definitions (`cards.json`), deck rules and `validate_deck`. The
//! match (hand, deck, supply, effects) is in `match_.rs`. See DECISIONS.md,
//! "Cards (T3)".

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::sim::Weapon;

/// The repository's `cards.json`, embedded like the config.
pub const DEFAULT_CARDS_JSON: &str = include_str!("../../../cards.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rarity {
    Common,
    Uncommon,
    Rare,
    Legendary,
}

/// When a card can be played: fortifications and armaments in prep,
/// tactical cards while the wave runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardKind {
    Fortification,
    Armament,
    Tactical,
}

impl std::fmt::Display for CardKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CardKind::Fortification => "fortification",
            CardKind::Armament => "armament",
            CardKind::Tactical => "tactical",
        })
    }
}

/// What a card's target must be.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Buildings,
    Polyline,
    Point,
}

impl std::fmt::Display for TargetKind {
    /// What the player must click: "must target buildings / a line / a point".
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TargetKind::Buildings => "buildings",
            TargetKind::Polyline => "a line",
            TargetKind::Point => "a point",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WeaponDef {
    pub range_m: f32,
    #[serde(default)]
    pub min_range_m: f32,
    pub damage: u16,
    /// Shots per second.
    pub fire_rate: f32,
    #[serde(default)]
    pub splash_m: f32,
}

impl WeaponDef {
    pub fn weapon(&self, cfg: &Config) -> Weapon {
        Weapon { range_m: self.range_m, min_range_m: self.min_range_m, damage: self.damage, period_ticks: cfg.period_ticks(self.fire_rate), splash_m: self.splash_m }
    }
}

/// A card's effect. Serialised with `"type"`: `fence`, `garrison`, `unit`,
/// `strike`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Effect {
    /// A fence polyline of at most `length_m` placed meters, `cell_hp` per cell.
    Fence { length_m: f32, cell_hp: f32 },
    /// Garrison up to `buildings` revealed buildings with `weapon`.
    Garrison { buildings: u32, weapon: WeaponDef },
    /// A unit that starts acting `delay_s` after the play: at a point
    /// (scattered by up to `scatter_m`), or driving along a polyline at
    /// `speed_m_s` when `follows_path`. Gone at the end of the wave.
    Unit {
        delay_s: f32,
        #[serde(default)]
        scatter_m: f32,
        #[serde(default)]
        follows_path: bool,
        #[serde(default)]
        speed_m_s: f32,
        weapon: WeaponDef,
    },
    /// `pulses` pulses of `damage` to every zombie within `radius_m` of a
    /// point, the first `delay_s` after the play, then every `interval_s`.
    Strike { delay_s: f32, radius_m: f32, damage: u16, pulses: u32, interval_s: f32 },
}

impl Effect {
    pub fn target_kind(&self) -> TargetKind {
        match self {
            Effect::Fence { .. } => TargetKind::Polyline,
            Effect::Garrison { .. } => TargetKind::Buildings,
            Effect::Unit { follows_path: true, .. } => TargetKind::Polyline,
            Effect::Unit { .. } | Effect::Strike { .. } => TargetKind::Point,
        }
    }
    /// The card kind this effect belongs to.
    pub fn kind(&self) -> CardKind {
        match self {
            Effect::Fence { .. } => CardKind::Fortification,
            Effect::Garrison { .. } => CardKind::Armament,
            Effect::Unit { .. } | Effect::Strike { .. } => CardKind::Tactical,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CardDef {
    pub id: String,
    pub name: String,
    pub rarity: Rarity,
    pub kind: CardKind,
    /// Supply spent to play it.
    pub cost: u32,
    #[serde(default)]
    pub text: String,
    pub effect: Effect,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaxCopies {
    pub common: u32,
    pub uncommon: u32,
    pub rare: u32,
    pub legendary: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeckRules {
    pub deck_size: u32,
    pub max_copies: MaxCopies,
    pub max_legendaries: u32,
}

impl DeckRules {
    pub fn max_copies(&self, r: Rarity) -> u32 {
        match r {
            Rarity::Common => self.max_copies.common,
            Rarity::Uncommon => self.max_copies.uncommon,
            Rarity::Rare => self.max_copies.rare,
            Rarity::Legendary => self.max_copies.legendary,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeckEntry {
    pub card: String,
    pub copies: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StarterDeck {
    pub id: String,
    pub name: String,
    pub cards: Vec<DeckEntry>,
}

impl StarterDeck {
    /// The deck as a list of card ids (entries in file order).
    pub fn card_ids(&self) -> Vec<String> {
        self.cards.iter().flat_map(|e| std::iter::repeat(e.card.clone()).take(e.copies as usize)).collect()
    }
}

/// Every card, the deck rules and the starter decks.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CardDb {
    pub deck_rules: DeckRules,
    pub starter_decks: Vec<StarterDeck>,
    pub cards: Vec<CardDef>,
}

/// Id of the starter deck every new player gets.
pub const STARTER_DECK: &str = "civil_defence_issue";

/// Why a deck is not legal. `validate_deck` returns all of them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum DeckError {
    /// The deck must have exactly `expected` cards.
    WrongSize { size: u32, expected: u32 },
    UnknownCard { card: String },
    /// More copies of a card than its rarity allows.
    TooManyCopies { card: String, rarity: Rarity, copies: u32, max: u32 },
    /// More legendary cards than allowed in one deck.
    TooManyLegendaries { count: u32, max: u32 },
}

impl std::fmt::Display for DeckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeckError::WrongSize { size, expected } => write!(f, "a deck has exactly {expected} cards, this one has {size}"),
            DeckError::UnknownCard { card } => write!(f, "unknown card \"{card}\""),
            DeckError::TooManyCopies { card, rarity, copies, max } => write!(f, "{copies} copies of \"{card}\": at most {max} of a {rarity:?} card"),
            DeckError::TooManyLegendaries { count, max } => write!(f, "{count} legendary cards: at most {max} per deck"),
        }
    }
}

impl CardDb {
    pub fn from_json(s: &str) -> Result<CardDb, String> {
        let db: CardDb = serde_json::from_str(s).map_err(|e| format!("cards: {e}"))?;
        db.check()?;
        Ok(db)
    }

    pub fn default_cards() -> CardDb {
        CardDb::from_json(DEFAULT_CARDS_JSON).expect("cards.json is valid")
    }

    /// Internal consistency: unique ids, kinds matching effects, sane
    /// numbers, legal starter decks.
    fn check(&self) -> Result<(), String> {
        for (i, c) in self.cards.iter().enumerate() {
            if self.cards[..i].iter().any(|o| o.id == c.id) {
                return Err(format!("cards: duplicate id {}", c.id));
            }
            if c.effect.kind() != c.kind {
                return Err(format!("cards: {} is {:?} but its effect is {:?}", c.id, c.kind, c.effect.kind()));
            }
            let ok = match &c.effect {
                Effect::Fence { length_m, cell_hp } => *length_m > 0.0 && *cell_hp > 0.0,
                Effect::Garrison { buildings, weapon } => *buildings > 0 && weapon.fire_rate > 0.0 && weapon.range_m > weapon.min_range_m,
                Effect::Unit { delay_s, follows_path, speed_m_s, weapon, scatter_m } => {
                    *delay_s >= 0.0 && *scatter_m >= 0.0 && weapon.fire_rate > 0.0 && (!follows_path || *speed_m_s > 0.0)
                }
                Effect::Strike { delay_s, radius_m, pulses, interval_s, .. } => *delay_s >= 0.0 && *radius_m > 0.0 && *pulses > 0 && *interval_s > 0.0,
            };
            if !ok {
                return Err(format!("cards: {} has invalid effect numbers", c.id));
            }
        }
        for d in &self.starter_decks {
            self.validate_deck(&d.card_ids()).map_err(|e| format!("cards: starter deck {}: {}", d.id, e[0]))?;
        }
        Ok(())
    }

    /// Index of a card id.
    pub fn index(&self, id: &str) -> Option<usize> {
        self.cards.iter().position(|c| c.id == id)
    }

    pub fn get(&self, id: &str) -> Option<&CardDef> {
        self.cards.iter().find(|c| c.id == id)
    }

    pub fn starter_deck(&self, id: &str) -> Option<&StarterDeck> {
        self.starter_decks.iter().find(|d| d.id == id)
    }

    /// The "Civil Defence Issue" starter deck as card ids.
    pub fn starter_deck_ids(&self) -> Vec<String> {
        self.starter_deck(STARTER_DECK).map(|d| d.card_ids()).unwrap_or_default()
    }

    /// Check a deck (card ids) against the deck rules. Returns every
    /// problem: size, unknown cards, copies per rarity, legendaries.
    pub fn validate_deck(&self, deck: &[String]) -> Result<(), Vec<DeckError>> {
        let r = &self.deck_rules;
        let mut errors = Vec::new();
        if deck.len() as u32 != r.deck_size {
            errors.push(DeckError::WrongSize { size: deck.len() as u32, expected: r.deck_size });
        }
        // Distinct ids in first-seen order (deterministic error order).
        let mut seen: Vec<(&str, u32)> = Vec::new();
        for id in deck {
            match seen.iter_mut().find(|(s, _)| *s == id.as_str()) {
                Some((_, n)) => *n += 1,
                None => seen.push((id.as_str(), 1)),
            }
        }
        let mut legendaries = 0;
        for &(id, copies) in &seen {
            match self.get(id) {
                None => errors.push(DeckError::UnknownCard { card: id.to_string() }),
                Some(c) => {
                    let max = r.max_copies(c.rarity);
                    if copies > max {
                        errors.push(DeckError::TooManyCopies { card: id.to_string(), rarity: c.rarity, copies, max });
                    }
                    if c.rarity == Rarity::Legendary {
                        legendaries += copies;
                    }
                }
            }
        }
        if legendaries > r.max_legendaries {
            errors.push(DeckError::TooManyLegendaries { count: legendaries, max: r.max_legendaries });
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// FNV-1a of the canonical JSON (T4 puts it in run records).
    pub fn content_hash(&self) -> u64 {
        let s = serde_json::to_string(self).expect("cards serialise");
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in s.as_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }
}

/// `CardDb::validate_deck` with the embedded card list.
pub fn validate_deck(deck: &[String]) -> Result<(), Vec<DeckError>> {
    CardDb::default_cards().validate_deck(deck)
}
