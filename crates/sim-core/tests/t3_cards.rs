//! T3: cards, deck rules, hand / deck / discard, supply, card effects,
//! upkeep (repair, pull down), retries with cards.
mod common;
use sim_core::cards::{CardDb, CardKind, DeckError, Effect, Rarity, TargetKind, STARTER_DECK};
use sim_core::grid::{FENCE, WALK};
use sim_core::level::LevelPack;
use sim_core::match_::{Action, ActionError, DebugCardEdit, Match, MatchError, MatchSetup, Phase, StructureKind, TakenCell, Target};
use sim_core::sim::{Sim, Tower, INFECTED, ZOMBIE};
use sim_core::Config;

fn marais() -> LevelPack {
    common::level("paris-marais")
}

fn ids(list: &[(&str, usize)]) -> Vec<String> {
    list.iter().flat_map(|&(c, n)| std::iter::repeat(c.to_string()).take(n)).collect()
}

/// The embedded cards with every copy limit lifted (test decks of one card).
fn relaxed() -> CardDb {
    let mut db = CardDb::default_cards();
    let mc = &mut db.deck_rules.max_copies;
    (mc.common, mc.uncommon, mc.rare, mc.legendary) = (20, 20, 20, 20);
    db.deck_rules.max_legendaries = 20;
    db
}

fn match_with(cfg: Config, deck: Vec<String>, seed: u64) -> Match {
    let setup = MatchSetup::new(seed, &cfg).with_deck(deck);
    Match::new_with_cards(&marais(), cfg, relaxed(), setup).unwrap()
}

/// A match whose deck is 20 copies of `card`.
fn mono(card: &str, seed: u64) -> Match {
    match_with(common::cfg(), vec![card.to_string(); 20], seed)
}

fn starter(seed: u64) -> Match {
    let cfg = common::cfg();
    let setup = MatchSetup::new(seed, &cfg);
    Match::new(&marais(), cfg, setup).unwrap()
}

fn clear_outbreak(m: &mut Match) {
    let sim = m.debug_sim_mut();
    for i in 0..sim.n {
        if sim.state[i] == ZOMBIE || sim.state[i] == INFECTED {
            sim.force_kill(i);
        }
    }
}

/// Start, run `ticks`, clear the outbreak: the next tick wins.
fn fast_win(m: &mut Match, ticks: u32) {
    m.apply(Action::StartWave).unwrap();
    for _ in 0..ticks {
        m.step();
    }
    clear_outbreak(m);
    m.step();
    assert!(matches!(m.phase(), Phase::WaveWon | Phase::MatchWon), "{:?}", m.phase());
}

/// The first `n` revealed buildings without a garrison.
fn free_buildings(m: &Match, n: usize) -> Vec<u32> {
    let sim = m.sim();
    (0..sim.grid.buildings.len() as u32)
        .filter(|&b| {
            let i = &sim.grid.buildings[b as usize];
            i.cell_count > 0 && m.wave_of_point(i.centroid[0], i.centroid[1]) <= m.wave() && !sim.towers.iter().any(|t| t.building == b)
        })
        .take(n)
        .collect()
}

fn hand_index_of(m: &Match, card: &str) -> u32 {
    m.hand().iter().find(|c| c.card == card).unwrap_or_else(|| panic!("{card} not in hand {:?}", m.hand_ids())).hand_index
}

/// Every card id in hand + deck + discard, sorted (conservation checks).
fn all_cards(m: &Match) -> Vec<String> {
    let mut v: Vec<String> = m.hand_ids().iter().chain(m.debug_deck_ids().iter()).chain(m.discard_ids().iter()).map(|s| s.to_string()).collect();
    v.sort();
    v
}

// ------------------------------------------------------------------ data

#[test]
fn cards_json_has_the_v1_cards() {
    let db = CardDb::default_cards();
    let get = |id: &str| db.get(id).unwrap_or_else(|| panic!("missing {id}"));
    assert!(matches!(get("light_fence").effect, Effect::Fence { length_m, .. } if length_m == 400.0));
    assert!(matches!(get("heavy_stockade").effect, Effect::Fence { length_m, .. } if length_m == 100.0));
    let (Effect::Fence { cell_hp: light, .. }, Effect::Fence { cell_hp: heavy, .. }) = (&get("light_fence").effect, &get("heavy_stockade").effect) else { panic!() };
    assert_eq!(*light, common::cfg().fence_cell_hp, "light fence = today's fence");
    assert!(*heavy >= 5.0 * light, "stockade is very resistant");
    let cfg = common::cfg();
    match &get("rifles").effect {
        Effect::Garrison { buildings: 3, weapon } => assert_eq!(weapon.weapon(&cfg), cfg.tower_weapon(), "rifles = today's tower"),
        e => panic!("{e:?}"),
    }
    match &get("mortar").effect {
        Effect::Garrison { buildings: 2, weapon } => {
            assert!(weapon.splash_m > 0.0 && weapon.min_range_m > 0.0 && weapon.fire_rate < cfg.tower_fire_rate);
        }
        e => panic!("{e:?}"),
    }
    assert!(matches!(get("paratrooper").effect, Effect::Unit { delay_s, follows_path: false, .. } if delay_s == 10.0));
    assert_eq!(get("paratrooper").kind, CardKind::Tactical);
    for id in ["sniper_nest", "napalm", "concrete_barriers"] {
        assert_eq!(get(id).rarity, Rarity::Rare, "{id}");
    }
    for id in ["airstrike", "armored_convoy"] {
        assert_eq!(get(id).rarity, Rarity::Legendary, "{id}");
    }
    assert!(matches!(get("armored_convoy").effect.target_kind(), TargetKind::Polyline));
    // The starter deck: 20 commons and uncommons, legal.
    let s = db.starter_deck(STARTER_DECK).unwrap();
    assert_eq!(s.name, "Civil Defence Issue");
    let deck = db.starter_deck_ids();
    assert_eq!(deck.len(), 20);
    assert!(deck.iter().all(|c| matches!(db.get(c).unwrap().rarity, Rarity::Common | Rarity::Uncommon)));
    assert_eq!(db.validate_deck(&deck), Ok(()));
    assert_eq!(sim_core::validate_deck(&deck), Ok(()));
    // Bad files are refused.
    let bad = sim_core::cards::DEFAULT_CARDS_JSON.replace("\"kind\": \"tactical\", \"cost\": 2", "\"kind\": \"armament\", \"cost\": 2");
    assert!(CardDb::from_json(&bad).unwrap_err().contains("paratrooper"));
}

#[test]
fn deck_rules_are_enforced_with_clear_errors() {
    let db = CardDb::default_cards();
    let base = db.starter_deck_ids();
    // Size.
    let short = base[..19].to_vec();
    assert_eq!(db.validate_deck(&short), Err(vec![DeckError::WrongSize { size: 19, expected: 20 }]));
    let mut long = base.clone();
    long.push("sniper_nest".into());
    assert_eq!(db.validate_deck(&long), Err(vec![DeckError::WrongSize { size: 21, expected: 20 }]));
    // Unknown card.
    let mut unknown = base.clone();
    unknown[0] = "laser_cannon".into();
    assert!(db.validate_deck(&unknown).unwrap_err().contains(&DeckError::UnknownCard { card: "laser_cannon".into() }));
    // Copies: 3 commons ok, 4 not; 2 uncommons ok, 3 not; 1 rare ok, 2 not.
    let rest = |n: usize| ids(&[("rifles", 3), ("hunting_rifles", 3), ("militia", 3), ("light_fence", 3), ("barbed_wire", 3), ("grenades", 3), ("machine_gun_nest", 2)])[..n].to_vec();
    let with = |extra: &[(&str, usize)]| {
        let e = ids(extra);
        let mut d = rest(20 - e.len());
        d.extend(e);
        d
    };
    assert_eq!(db.validate_deck(&rest(18).into_iter().chain(ids(&[("mortar", 2)])).collect::<Vec<_>>()), Ok(()));
    let four_rifles: Vec<String> = ids(&[("rifles", 4)]).into_iter().chain(rest(19)[3..].iter().cloned()).collect();
    assert_eq!(four_rifles.len(), 20);
    assert_eq!(db.validate_deck(&four_rifles), Err(vec![DeckError::TooManyCopies { card: "rifles".into(), rarity: Rarity::Common, copies: 4, max: 3 }]));
    assert_eq!(db.validate_deck(&with(&[("mortar", 3)])), Err(vec![DeckError::TooManyCopies { card: "mortar".into(), rarity: Rarity::Uncommon, copies: 3, max: 2 }]));
    assert_eq!(db.validate_deck(&with(&[("sniper_nest", 1), ("napalm", 1)])), Ok(()));
    assert_eq!(db.validate_deck(&with(&[("sniper_nest", 2)])), Err(vec![DeckError::TooManyCopies { card: "sniper_nest".into(), rarity: Rarity::Rare, copies: 2, max: 1 }]));
    // Legendaries: 1 copy each, at most 2 per deck.
    assert_eq!(db.validate_deck(&with(&[("airstrike", 1), ("armored_convoy", 1)])), Ok(()));
    assert_eq!(
        db.validate_deck(&with(&[("airstrike", 2)])),
        Err(vec![DeckError::TooManyCopies { card: "airstrike".into(), rarity: Rarity::Legendary, copies: 2, max: 1 }])
    );
    let mut three = db.clone();
    three.cards.push(sim_core::cards::CardDef { id: "orbital".into(), name: "Orbital".into(), ..three.get("airstrike").unwrap().clone() });
    assert_eq!(three.validate_deck(&with(&[("airstrike", 1), ("armored_convoy", 1), ("orbital", 1)])), Err(vec![DeckError::TooManyLegendaries { count: 3, max: 2 }]));
    // Every problem is reported, with readable messages.
    let mut many = with(&[("airstrike", 2), ("sniper_nest", 2)]);
    many.push("rifles".into());
    let errs = db.validate_deck(&many).unwrap_err();
    assert_eq!(errs.len(), 4, "size, rifles, airstrike, sniper: {errs:?}");
    assert!(errs.contains(&DeckError::TooManyCopies { card: "rifles".into(), rarity: Rarity::Common, copies: 4, max: 3 }));
    assert!(errs.iter().any(|e| e.to_string().contains("at most 1 of a Legendary card")), "{errs:?}");
    assert!(errs[0].to_string().contains("exactly 20 cards"));
    // The match refuses an illegal deck.
    let cfg = common::cfg();
    let setup = MatchSetup::new(1, &cfg).with_deck(short);
    assert!(matches!(Match::new(&marais(), cfg, setup), Err(MatchError::InvalidDeck(_))));
}

// ------------------------------------------------------------------ hand

#[test]
fn draw_keep_discard_reshuffle_over_eight_waves() {
    let cfg = common::cfg();
    let (draw, keep) = (cfg.match_.hand_draw as usize, cfg.match_.hand_keep as usize);
    let run = |seed: u64| {
        let mut m = starter(seed);
        let deck: Vec<String> = {
            let mut d = m.deck_list().to_vec();
            d.sort();
            d
        };
        let mut hands = Vec::new();
        assert_eq!(m.hand_ids().len(), draw);
        assert_eq!(m.deck_count() as usize, 20 - draw);
        let mut reshuffles = 0;
        for wave in 1..=8u8 {
            assert_eq!(m.wave(), wave);
            hands.push(m.hand_ids().iter().map(|s| s.to_string()).collect::<Vec<_>>());
            assert_eq!(all_cards(&m), deck, "wave {wave}: cards are conserved");
            // Wave 3: play the first playable card; wave 5: mark the last two to keep.
            if wave == 3 {
                {
                    let c = m.hand().into_iter().find(|c| c.playable && c.kind == CardKind::Armament).expect("an armament in hand");
                    let card = c.card.clone();
                    let d0 = m.discard_count();
                    m.apply(Action::PlayCard { hand_index: c.hand_index, target: Target::Buildings(free_buildings(&m, 1)) }).unwrap();
                    assert_eq!(m.discard_ids().last().copied(), Some(card.as_str()), "a played card goes to the discard");
                    assert_eq!(m.discard_count(), d0 + 1);
                }
            }
            let hand_before: Vec<String> = m.hand_ids().iter().map(|s| s.to_string()).collect();
            let kept: Vec<String> = if wave == 5 {
                let n = hand_before.len() as u32;
                m.apply(Action::KeepCards { hand_indices: vec![n - 1, n - 2] }).unwrap();
                vec![hand_before[n as usize - 2].clone(), hand_before[n as usize - 1].clone()]
            } else {
                hand_before.iter().take(keep).cloned().collect()
            };
            fast_win(&mut m, 10);
            if wave == 8 {
                break;
            }
            let deck_before = m.deck_count() as usize;
            let discard_before = m.discard_count() as usize;
            m.apply(Action::NextWave).unwrap();
            let hand = m.hand_ids();
            // Kept cards first, in hand order, then 5 new ones.
            assert_eq!(hand[..kept.len()].iter().map(|s| s.to_string()).collect::<Vec<_>>(), kept, "wave {}", wave + 1);
            assert_eq!(hand.len(), kept.len() + draw);
            let discarded = hand_before.len() - kept.len();
            if deck_before >= draw {
                assert_eq!(m.deck_count() as usize, deck_before - draw);
                assert_eq!(m.discard_count() as usize, discard_before + discarded);
                assert_eq!(m.reshuffles(), reshuffles);
            } else {
                // The deck ran out: the discard was shuffled into it.
                reshuffles += 1;
                assert_eq!(m.reshuffles(), reshuffles);
                assert_eq!(m.discard_count(), 0);
                assert_eq!(m.deck_count() as usize, deck_before + discard_before + discarded - draw);
            }
        }
        assert!(reshuffles >= 1, "8 waves go through the deck at least once");
        (hands, m.state_hash())
    };
    let (a, ha) = run(21);
    let (b, hb) = run(21);
    assert_eq!((a.clone(), ha), (b, hb), "same seed, same draws");
    let (c, _) = run(22);
    assert_ne!(a, c, "another seed shuffles differently");
}

#[test]
fn mulligan_and_keep_rules() {
    let mut m = starter(23);
    let supply = m.supply();
    let hand: Vec<String> = m.hand_ids().iter().map(|s| s.to_string()).collect();
    assert!(m.mulligan_available());
    m.apply(Action::Mulligan).unwrap();
    assert_eq!(m.supply(), supply - m.mulligan_cost());
    assert_eq!(m.hand_ids().len(), hand.len());
    // The old hand is at the bottom of the deck, first card lowest.
    let deck = m.debug_deck_ids();
    let bottom: Vec<String> = deck.iter().rev().take(hand.len()).map(|s| s.to_string()).collect();
    assert_eq!(bottom, hand);
    assert_eq!(m.apply(Action::Mulligan), Err(ActionError::MulliganUsed));
    assert!(!m.mulligan_available());
    // Next wave: a mulligan again, but not after playing a card.
    fast_win(&mut m, 5);
    m.apply(Action::NextWave).unwrap();
    {
        let c = m.hand().into_iter().find(|c| c.playable && c.target == TargetKind::Buildings).expect("an armament in hand");
        m.apply(Action::PlayCard { hand_index: c.hand_index, target: Target::Buildings(free_buildings(&m, 1)) }).unwrap();
        assert_eq!(m.apply(Action::Mulligan), Err(ActionError::MulliganAfterPlay));
    }
    // Keep: at most hand_keep, valid and distinct indices.
    assert_eq!(m.apply(Action::KeepCards { hand_indices: vec![0, 1, 2] }), Err(ActionError::TooManyKept { max: 2 }));
    assert_eq!(m.apply(Action::KeepCards { hand_indices: vec![1, 1] }), Err(ActionError::DuplicateIndex { hand_index: 1 }));
    assert_eq!(m.apply(Action::KeepCards { hand_indices: vec![40] }), Err(ActionError::NoSuchCard { hand_index: 40 }));
    m.apply(Action::KeepCards { hand_indices: vec![2] }).unwrap();
    assert_eq!(m.hand().iter().map(|c| c.keep).collect::<Vec<_>>(), (0..m.hand_ids().len()).map(|i| i == 2).collect::<Vec<_>>());
    // Keeping nothing (an explicit empty choice) discards the whole hand.
    m.apply(Action::KeepCards { hand_indices: vec![] }).unwrap();
    fast_win(&mut m, 5);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(m.hand_ids().len(), 5);
    // With no choice this wave, the first two stay.
    fast_win(&mut m, 5);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(m.hand_ids().len(), 5 + 2);
    // Mulligan is a prep action; an empty hand can't mulligan; supply is checked.
    let mut e = mono("rifles", 24);
    e.apply(Action::StartWave).unwrap();
    assert_eq!(e.apply(Action::Mulligan), Err(ActionError::WrongPhase { action: "mulligan".into(), phase: Phase::Running }));
    let mut cfg = common::cfg();
    cfg.match_.mulligan_cost = 100;
    let mut p = match_with(cfg, vec!["rifles".into(); 20], 25);
    assert_eq!(p.apply(Action::Mulligan), Err(ActionError::NotEnoughSupply { need: 100, have: p.supply() }));
}

// ------------------------------------------------------------------ supply

#[test]
fn supply_income_and_carry_over() {
    let cfg = common::cfg();
    let mc = cfg.match_.clone();
    let mut m = mono("rifles", 26);
    assert_eq!(m.supply(), mc.supply_start + mc.supply_base_income);
    assert_eq!(m.supply_income().base, mc.supply_start + mc.supply_base_income);
    // Spend 3 on Rifles, carry the rest.
    m.apply(Action::PlayCard { hand_index: 0, target: Target::Buildings(free_buildings(&m, 3)) }).unwrap();
    let left = m.supply();
    assert_eq!(left, mc.supply_start + mc.supply_base_income - 3);
    fast_win(&mut m, 40);
    let r = m.results()[0].clone();
    let bonus = r.end_civilians / mc.supply_civilians_per_point[0];
    assert!(bonus > 0);
    assert_eq!(r.supply_earned, mc.supply_base_income + bonus);
    assert_eq!(r.cards_played, 1);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(m.supply(), left + mc.supply_base_income + bonus, "carry-over + base + civilians");
    assert_eq!(m.supply_income().base, mc.supply_base_income);
    assert_eq!(m.supply_income().civilians, bonus);
    // Wave 2 uses the next N.
    let s2 = m.supply();
    fast_win(&mut m, 5);
    let r2 = m.results()[1].clone();
    assert_eq!(r2.supply_earned, mc.supply_base_income + r2.end_civilians / mc.supply_civilians_per_point[1]);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(m.supply(), s2 + r2.supply_earned);
    // Not enough supply.
    let mut cfg = common::cfg();
    cfg.match_.supply_start = 0;
    cfg.match_.supply_base_income = 2;
    let mut p = match_with(cfg, vec!["rifles".into(); 20], 27);
    assert_eq!(p.can_play(0), Err(ActionError::NotEnoughSupply { need: 3, have: 2 }));
    assert_eq!(p.apply(Action::PlayCard { hand_index: 0, target: Target::Buildings(free_buildings(&p, 1)) }), Err(ActionError::NotEnoughSupply { need: 3, have: 2 }));
    assert!(p.hand().iter().all(|c| !c.playable));
    // A lost wave earns nothing.
    let mut lost = mono("rifles", 28);
    lost.apply(Action::StartWave).unwrap();
    while lost.phase() == Phase::Running {
        lost.step();
    }
    assert_eq!(lost.phase(), Phase::WaveLost);
    assert_eq!(lost.results()[0].supply_earned, 0);
}

// ------------------------------------------------------------------ phases

#[test]
fn phase_restrictions_use_the_right_error() {
    let mut m = match_with(common::cfg(), ids(&[("rifles", 7), ("light_fence", 7), ("paratrooper", 6)]), 29);
    // Make sure each kind is in hand (mulligan until it is, at most once).
    let has = |m: &Match, k: CardKind| m.hand().iter().any(|c| c.kind == k);
    if !(has(&m, CardKind::Tactical) && has(&m, CardKind::Armament)) {
        m.apply(Action::Mulligan).unwrap();
    }
    assert!(has(&m, CardKind::Tactical) && has(&m, CardKind::Armament), "{:?}", m.hand_ids());
    let tac = hand_index_of(&m, "paratrooper");
    let [cx, cy] = m.center();
    assert_eq!(
        m.apply(Action::PlayCard { hand_index: tac, target: Target::Point([cx, cy]) }),
        Err(ActionError::CardWrongPhase { card: "paratrooper".into(), kind: CardKind::Tactical, phase: Phase::Prep })
    );
    let msg = m.can_play(tac).unwrap_err().to_string();
    assert!(msg.contains("during a wave"), "{msg}");
    m.apply(Action::StartWave).unwrap();
    m.step();
    let arm = hand_index_of(&m, "rifles");
    assert_eq!(
        m.apply(Action::PlayCard { hand_index: arm, target: Target::Buildings(free_buildings(&m, 1)) }),
        Err(ActionError::CardWrongPhase { card: "rifles".into(), kind: CardKind::Armament, phase: Phase::Running })
    );
    assert!(m.can_play(arm).unwrap_err().to_string().contains("during prep"));
    {
        let f = m.hand().into_iter().find(|c| c.kind == CardKind::Fortification).expect("a fence in hand");
        assert_eq!(
            m.apply(Action::PlayCard { hand_index: f.hand_index, target: Target::Polyline(vec![[cx, cy], [cx + 10.0, cy]]) }),
            Err(ActionError::CardWrongPhase { card: "light_fence".into(), kind: CardKind::Fortification, phase: Phase::Running })
        );
    }
    for (a, name) in [(Action::Repair { fence_id: 1 }, "repair"), (Action::PullDown { placement_id: 1 }, "pull_down"), (Action::Mulligan, "mulligan")] {
        assert_eq!(m.apply(a), Err(ActionError::WrongPhase { action: name.into(), phase: Phase::Running }));
    }
    // Tactical works while running; nothing works on the result screen.
    let tac = hand_index_of(&m, "paratrooper");
    m.apply(Action::PlayCard { hand_index: tac, target: Target::Point([cx, cy]) }).unwrap();
    clear_outbreak(&mut m);
    m.step();
    assert_eq!(m.phase(), Phase::WaveWon);
    let any = m.hand()[0].clone();
    assert!(matches!(m.can_play(0), Err(ActionError::CardWrongPhase { phase: Phase::WaveWon, .. })), "{any:?}");
    // Wrong target kinds and bad indices.
    m.apply(Action::NextWave).unwrap();
    let arm = hand_index_of(&m, "rifles");
    assert_eq!(m.apply(Action::PlayCard { hand_index: arm, target: Target::Point([cx, cy]) }), Err(ActionError::WrongTarget { card: "rifles".into(), expected: TargetKind::Buildings }));
    assert_eq!(m.apply(Action::PlayCard { hand_index: 99, target: Target::Point([cx, cy]) }), Err(ActionError::NoSuchCard { hand_index: 99 }));
    let n = m.log().len();
    let _ = m.apply(Action::PlayCard { hand_index: 99, target: Target::Point([cx, cy]) });
    assert_eq!(m.log().len(), n, "refused plays are not logged");
}

// ------------------------------------------------------------------ effects

#[test]
fn garrison_cards_equip_buildings() {
    let mut m = match_with(common::cfg(), ids(&[("rifles", 10), ("hunting_rifles", 10)]), 30);
    let cfg = common::cfg();
    let r = hand_index_of(&m, "rifles");
    let four = free_buildings(&m, 4);
    assert_eq!(m.apply(Action::PlayCard { hand_index: r, target: Target::Buildings(four.clone()) }), Err(ActionError::TooManyBuildings { card: "rifles".into(), max: 3 }));
    assert!(matches!(m.apply(Action::PlayCard { hand_index: r, target: Target::Buildings(vec![four[0], four[0]]) }), Err(ActionError::Placement { .. })));
    let far = (0..m.sim().grid.buildings.len() as u32).find(|&b| {
        let c = m.sim().grid.buildings[b as usize].centroid;
        m.wave_of_point(c[0], c[1]) > 1
    });
    assert_eq!(m.apply(Action::PlayCard { hand_index: r, target: Target::Buildings(vec![far.unwrap()]) }), Err(ActionError::NotRevealed { building: far.unwrap() }));
    m.apply(Action::PlayCard { hand_index: r, target: Target::Buildings(four[..3].to_vec()) }).unwrap();
    let t = &m.sim().towers;
    assert_eq!(t.len(), 3);
    assert!(t.iter().all(|t| t.weapon == cfg.tower_weapon() && !t.is_unit()));
    assert_eq!(m.structures().len(), 1);
    assert_eq!(m.structures()[0].kind, StructureKind::Garrison { buildings: four[..3].to_vec() });
    assert_eq!(m.structure_of_building(four[1]).unwrap().id, m.structures()[0].id);
    {
        let h = m.hand().into_iter().find(|c| c.card == "hunting_rifles").expect("hunting rifles in hand");
        assert_eq!(m.apply(Action::PlayCard { hand_index: h.hand_index, target: Target::Buildings(vec![four[2]]) }), Err(ActionError::AlreadyGarrisoned { building: four[2] }));
        m.apply(Action::PlayCard { hand_index: h.hand_index, target: Target::Buildings(vec![four[3]]) }).unwrap();
        let w = m.sim().towers[3].weapon;
        assert_eq!((w.range_m, w.damage, w.period_ticks), (55.0, 50, 20));
    }
}

/// A single-wave sim with a few civilians and frozen, harmless zombies.
fn frozen_sim() -> Sim {
    let mut cfg = common::cfg();
    cfg.zombie_speed = 0.0;
    cfg.bite_radius_m = 0.0;
    cfg.civilian_wander_speed = 0.0;
    cfg.civilian_flee_speed = 0.0;
    Sim::new(&marais(), cfg, 40, 31)
}

#[test]
fn mortar_splash_and_minimum_range() {
    let db = CardDb::default_cards();
    let Effect::Garrison { weapon, .. } = db.get("mortar").unwrap().effect.clone() else { panic!() };
    let mut sim = frozen_sim();
    let w = weapon.weapon(&sim.cfg);
    assert_eq!((w.min_range_m, w.splash_m, w.period_ticks), (20.0, 8.0, 40));
    let [tx, ty] = sim.to_sim(0.0, 0.0);
    sim.towers.push(Tower::garrison(0, tx, ty, w));
    // A zombie inside the minimum range is never targeted.
    sim.force_zombie(0, tx + 10.0, ty);
    sim.start_without_outbreak();
    for _ in 0..60 {
        sim.step();
    }
    assert_eq!(sim.towers[0].shots, 0, "within the minimum range");
    assert_eq!(sim.hp[0], sim.cfg.zombie_hp);
    // Target at 50 m; a second zombie 5 m from it is splashed, one 15 m away is not.
    sim.force_zombie(1, tx, ty + 50.0);
    sim.force_zombie(2, tx + 4.0, ty + 53.0);
    sim.force_zombie(3, tx - 15.0, ty + 50.0);
    sim.step();
    assert_eq!(sim.towers[0].shots, 1);
    let hp = sim.cfg.zombie_hp - w.damage;
    assert_eq!((sim.hp[0], sim.hp[1], sim.hp[2], sim.hp[3]), (sim.cfg.zombie_hp, hp, hp, sim.cfg.zombie_hp));
    // Slow: the next shot comes 40 ticks later and kills both.
    for _ in 0..39 {
        sim.step();
    }
    assert_eq!(sim.towers[0].shots, 1);
    sim.step();
    assert_eq!(sim.towers[0].shots, 2);
    assert_eq!((sim.state[1], sim.state[2]), (sim_core::sim::DEAD, sim_core::sim::DEAD));
    assert_eq!(sim.towers[0].kills, 2);
}

#[test]
fn fences_from_cards_have_their_length_and_hp() {
    let mut m = match_with(common::cfg(), ids(&[("heavy_stockade", 10), ("light_fence", 10)]), 32);
    let [cx, cy] = m.center();
    let s = hand_index_of(&m, "heavy_stockade");
    // 100 m max: a 150 m open line is refused, with a reason.
    let line = |y: f32, len: f32| vec![[cx - len / 2.0, cy + y], [cx + len / 2.0, cy + y]];
    let long: Vec<[f32; 2]> = (0..6).map(|k| [cx - 60.0 + 24.0 * k as f32, cy + 2.0 * (k % 2) as f32]).collect();
    let l = m.fence_length_m(&long).unwrap();
    assert!(l > 30.0 && l < 100.0, "test line is {l} m");
    // The limit, on a stockade shortened to 30 m (no straight 100 m street here).
    let mut short = relaxed();
    short.cards.iter_mut().find(|c| c.id == "heavy_stockade").unwrap().effect = Effect::Fence { length_m: 30.0, cell_hp: 2400.0 };
    let cfg = common::cfg();
    let mut m2 = Match::new_with_cards(&marais(), cfg.clone(), short, MatchSetup::new(32, &cfg).with_deck(vec!["heavy_stockade".into(); 20])).unwrap();
    let e = m2.apply(Action::PlayCard { hand_index: 0, target: Target::Polyline(long.clone()) }).unwrap_err();
    assert!(matches!(&e, ActionError::Placement { reason } if reason.contains("allows 30 m")), "{e}");
    assert_eq!(m.apply(Action::PlayCard { hand_index: s, target: Target::Point([cx, cy]) }), Err(ActionError::WrongTarget { card: "heavy_stockade".into(), expected: TargetKind::Polyline }));
    m.apply(Action::PlayCard { hand_index: s, target: Target::Polyline(line(-50.0, 30.0)) }).unwrap();
    let st = m.structures()[0].clone();
    let StructureKind::Fence { cells, cell_hp, length_m, .. } = &st.kind else { panic!() };
    assert_eq!(*cell_hp, 2400.0);
    assert!(*length_m <= 100.0 && !cells.is_empty());
    assert!(cells.iter().all(|&c| m.sim().grid.kind[c as usize] == FENCE && m.sim().grid.fence_hp[c as usize] == 2400.0));
    assert_eq!(m.structure_at_cell(cells[0]).unwrap().id, st.id);
    {
        let f = m.hand().into_iter().find(|c| c.card == "light_fence").expect("light fence in hand");
        m.apply(Action::PlayCard { hand_index: f.hand_index, target: Target::Polyline(line(-60.0, 30.0)) }).unwrap();
        let StructureKind::Fence { cells, cell_hp, .. } = &m.structures()[1].kind else { panic!() };
        assert_eq!(*cell_hp, 300.0);
        assert!(cells.iter().all(|&c| m.sim().grid.fence_hp[c as usize] == 300.0));
    }
    // Zombies chew at 10 hp/s: a stockade cell takes 240 zombie-seconds.
    let cfg = common::cfg();
    assert_eq!(2400.0 / cfg.zombie_fence_dps, 240.0);
}

/// Start the wave with no outbreak left and one frozen zombie at `p`.
fn one_frozen_zombie(m: &mut Match, p: [f32; 2]) -> usize {
    m.apply(Action::StartWave).unwrap();
    clear_outbreak(m);
    let sim = m.debug_sim_mut();
    let i = (0..sim.n).find(|&i| sim.state[i] == sim_core::sim::CIVILIAN).unwrap();
    sim.force_zombie(i, p[0], p[1]);
    i
}

fn frozen_cfg() -> Config {
    let mut cfg = common::cfg();
    cfg.zombie_speed = 0.0;
    cfg.bite_radius_m = 0.0;
    cfg
}

#[test]
fn paratrooper_lands_after_ten_seconds_and_shoots() {
    let mut m = match_with(frozen_cfg(), vec!["paratrooper".into(); 20], 33);
    let [cx, cy] = m.center();
    // Target an open cell near the centre.
    let c = m.sim().grid.cell_of(cx, cy);
    let target = m.sim().grid.cell_center((c..).find(|&c| m.sim().grid.kind[c] == WALK).unwrap());
    let z = one_frozen_zombie(&mut m, target);
    let supply = m.supply();
    let t0 = m.wave_tick();
    m.apply(Action::PlayCard { hand_index: 0, target: Target::Point(target) }).unwrap();
    assert_eq!(m.supply(), supply - 2);
    let u = m.sim().towers.last().unwrap().clone();
    assert!(u.is_unit());
    assert_eq!(u.active_from, t0 + 200, "10 s at 20 Hz");
    let d = ((u.x - target[0]).powi(2) + (u.y - target[1]).powi(2)).sqrt();
    assert!(d <= 15.0 + 3.0, "lands within the scatter (+ one cell): {d}");
    assert_eq!(m.sim().grid.kind[m.sim().grid.cell_of(u.x, u.y)], WALK, "on open ground");
    assert_eq!(u.weapon.range_m, 30.0);
    for _ in 0..200 {
        m.step();
        assert_eq!(m.sim().towers.last().unwrap().shots, 0, "no shot before landing");
    }
    assert_eq!(m.sim().hp[z], m.sim().cfg.zombie_hp);
    m.step();
    assert_eq!(m.sim().towers.last().unwrap().shots, 1, "fires on landing");
    // Assault rifle: 5 shots/s, 34 damage: dead on the third shot, 8 ticks later.
    for _ in 0..8 {
        m.step();
    }
    assert_eq!(m.phase(), Phase::WaveWon);
    assert_eq!(m.sim().towers.last().unwrap().kills, 1);
    // The landing spot comes from the match seed: same seed, same spot.
    let mut m2 = match_with(frozen_cfg(), vec!["paratrooper".into(); 20], 33);
    one_frozen_zombie(&mut m2, target);
    m2.apply(Action::PlayCard { hand_index: 0, target: Target::Point(target) }).unwrap();
    let u2 = m2.sim().towers.last().unwrap();
    assert_eq!((u2.x, u2.y), (u.x, u.y));
    // Units leave at the end of the wave; outside the revealed area is refused.
    m.apply(Action::NextWave).unwrap();
    assert!(m.sim().towers.iter().all(|t| !t.is_unit()));
    one_frozen_zombie(&mut m, target);
    let far = m.radius_m() + 30.0;
    assert_eq!(m.apply(Action::PlayCard { hand_index: 0, target: Target::Point([cx + far, cy]) }), Err(ActionError::OutsideRevealed));
}

#[test]
fn strikes_hit_an_area_after_their_delay() {
    let mut m = match_with(frozen_cfg(), ids(&[("grenades", 10), ("napalm", 10)]), 34);
    let [cx, cy] = m.center();
    let near = one_frozen_zombie(&mut m, [cx + 5.0, cy]);
    let far = {
        let sim = m.debug_sim_mut();
        let i = (0..sim.n).find(|&i| sim.state[i] == sim_core::sim::CIVILIAN).unwrap();
        sim.force_zombie(i, cx + 14.0, cy);
        i
    };
    let hp = m.sim().cfg.zombie_hp;
    assert!(m.hand_ids().contains(&"grenades") && m.hand_ids().contains(&"napalm"), "{:?}", m.hand_ids());
    {
        let g = hand_index_of(&m, "grenades");
        m.apply(Action::PlayCard { hand_index: g, target: Target::Point([cx, cy]) }).unwrap();
        for _ in 0..20 {
            m.step();
        }
        assert_eq!(m.sim().hp[near], hp, "1 s delay");
        m.step();
        assert_eq!(m.sim().state[near], sim_core::sim::DEAD, "inside 8 m");
        assert_eq!((m.sim().state[far], m.sim().hp[far]), (ZOMBIE, hp), "outside 8 m");
        assert_eq!(m.sim().effects[0].kills, 1);
    }
    {
        let n = hand_index_of(&m, "napalm");
        // Napalm: 3 s delay, then 25 per second: 4 pulses kill.
        m.apply(Action::PlayCard { hand_index: n, target: Target::Point([cx + 10.0, cy]) }).unwrap();
        for _ in 0..60 {
            m.step();
        }
        assert_eq!(m.sim().hp[far], hp);
        m.step();
        assert_eq!(m.sim().hp[far], hp - 25);
        for _ in 0..60 {
            m.step();
        }
        assert_eq!(m.sim().state[far], sim_core::sim::DEAD);
    }
}

#[test]
fn airstrike_and_convoy() {
    let mut m = match_with(frozen_cfg(), ids(&[("airstrike", 10), ("armored_convoy", 10)]), 35);
    let [cx, cy] = m.center();
    let z = one_frozen_zombie(&mut m, [cx + 30.0, cy]);
    let other = {
        let sim = m.debug_sim_mut();
        let i = (0..sim.n).find(|&i| sim.state[i] == sim_core::sim::CIVILIAN).unwrap();
        sim.force_zombie(i, cx - 45.0, cy - 100.0);
        i
    };
    // Convoy: drives the route at 5 m/s once its 5 s delay is over.
    let c = hand_index_of(&m, "armored_convoy");
    assert_eq!(m.apply(Action::PlayCard { hand_index: c, target: Target::Point([cx, cy]) }), Err(ActionError::WrongTarget { card: "armored_convoy".into(), expected: TargetKind::Polyline }));
    let route = vec![[cx - 45.0, cy + 60.0], [cx - 45.0, cy - 60.0]];
    m.apply(Action::PlayCard { hand_index: c, target: Target::Polyline(route.clone()) }).unwrap();
    let k = m.sim().towers.len() - 1;
    for _ in 0..100 {
        m.step();
    }
    assert_eq!((m.sim().towers[k].x, m.sim().towers[k].y), (route[0][0], route[0][1]));
    for _ in 0..40 {
        m.step();
    }
    let y = m.sim().towers[k].y;
    assert!((route[0][1] - y - 10.0).abs() < 1e-3, "10 m after 2 s: {}", route[0][1] - y);
    // Airstrike: everything within 40 m dies after 5 s.
    let a = hand_index_of(&m, "airstrike");
    m.apply(Action::PlayCard { hand_index: a, target: Target::Point([cx, cy]) }).unwrap();
    for _ in 0..100 {
        m.step();
    }
    assert_eq!(m.sim().state[z], ZOMBIE);
    m.step();
    assert_eq!(m.sim().state[z], sim_core::sim::DEAD);
    let _ = other;
}

// ------------------------------------------------------------------ upkeep

#[test]
fn repair_and_pull_down() {
    let cfg = common::cfg();
    let mc = cfg.match_.clone();
    let mut m = match_with(cfg, ids(&[("light_fence", 10), ("rifles", 10)]), 36);
    let [cx, cy] = m.center();
    let ensure = |m: &mut Match| {
        if !(m.hand_ids().contains(&"light_fence") && m.hand_ids().contains(&"rifles")) {
            m.apply(Action::Mulligan).unwrap();
        }
    };
    ensure(&mut m);
    let f = hand_index_of(&m, "light_fence");
    m.apply(Action::PlayCard { hand_index: f, target: Target::Polyline(vec![[cx - 20.0, cy - 50.0], [cx + 20.0, cy - 50.0]]) }).unwrap();
    let fence = m.structures()[0].clone();
    let r = hand_index_of(&m, "rifles");
    m.apply(Action::PlayCard { hand_index: r, target: Target::Buildings(free_buildings(&m, 3)) }).unwrap();
    let garrison = m.structures()[1].clone();
    assert_eq!(m.repair_cost(fence.id), None, "intact");
    assert_eq!(m.apply(Action::Repair { fence_id: fence.id }), Err(ActionError::NothingToRepair { fence_id: fence.id }));
    assert_eq!(m.apply(Action::Repair { fence_id: garrison.id }), Err(ActionError::NoSuchFence { fence_id: garrison.id }));
    assert_eq!(m.apply(Action::PullDown { placement_id: 999 }), Err(ActionError::NoSuchStructure { placement_id: 999 }));

    // Same prep: pulling down refunds everything and gives the card back.
    let (supply, hand, discard) = (m.supply(), m.hand_ids().len(), m.discard_count());
    assert_eq!(m.pull_down_refund(garrison.id), Some(3));
    m.apply(Action::PullDown { placement_id: garrison.id }).unwrap();
    assert_eq!((m.supply(), m.hand_ids().len(), m.discard_count()), (supply + 3, hand + 1, discard - 1));
    assert_eq!(*m.hand_ids().last().unwrap(), "rifles");
    assert!(m.sim().towers.is_empty());
    let r = hand_index_of(&m, "rifles");
    m.apply(Action::PlayCard { hand_index: r, target: Target::Buildings(free_buildings(&m, 3)) }).unwrap();
    let garrison = m.structures()[1].clone();

    // Next wave: damage the fence (half hp everywhere, one cell broken).
    fast_win(&mut m, 5);
    m.apply(Action::NextWave).unwrap();
    let StructureKind::Fence { cells, cell_hp, .. } = fence.kind.clone() else { panic!() };
    {
        let s = m.debug_sim_mut();
        for &c in &cells {
            s.grid.fence_hp[c as usize] = cell_hp * 0.5;
        }
        s.debug_break_fence_cell(cells[0] as usize);
    }
    let n = cells.len() as f32;
    let missing = 0.5 * cell_hp * (n - 1.0) + cell_hp;
    let share = missing / (n * cell_hp);
    let cost = (fence.cost as f32 * mc.repair_cost_factor * share).ceil() as u32;
    assert_eq!(m.repair_cost(fence.id), Some(cost.max(1)));
    let condition = 1.0 - share;
    assert_eq!(m.pull_down_refund(fence.id), Some((fence.cost as f32 * mc.pull_down_refund * condition).floor() as u32));
    let s0 = m.supply();
    m.apply(Action::Repair { fence_id: fence.id }).unwrap();
    assert_eq!(m.supply(), s0 - cost.max(1));
    assert!(cells.iter().all(|&c| m.sim().grid.kind[c as usize] == FENCE && m.sim().grid.fence_hp[c as usize] == cell_hp), "repaired, broken cell too");

    // Older structures refund part of their cost; the card stays in the discard.
    let (s1, hand1, discard1) = (m.supply(), m.hand_ids().len(), m.discard_count());
    let refund = (garrison.cost as f32 * mc.pull_down_refund).floor() as u32;
    m.apply(Action::PullDown { placement_id: garrison.id }).unwrap();
    assert_eq!((m.supply(), m.hand_ids().len(), m.discard_count()), (s1 + refund, hand1, discard1));
    assert!(m.sim().towers.is_empty());
    m.apply(Action::PullDown { placement_id: fence.id }).unwrap();
    assert_eq!(m.supply(), s1 + refund + (fence.cost as f32 * mc.pull_down_refund).floor() as u32);
    assert!(cells.iter().all(|&c| m.sim().grid.kind[c as usize] == WALK));
    assert!(m.structures().is_empty());
}

// ------------------------------------------------------------------ retries

#[test]
fn retry_restores_hand_deck_supply_and_structures() {
    let mut m = starter(37);
    fast_win(&mut m, 20);
    m.apply(Action::NextWave).unwrap();
    let prep = m.state_hash();
    let snap = |m: &Match| (m.supply(), m.hand_ids().iter().map(|s| s.to_string()).collect::<Vec<_>>(), m.debug_deck_ids().iter().map(|s| s.to_string()).collect::<Vec<_>>(), m.discard_ids().iter().map(|s| s.to_string()).collect::<Vec<_>>(), m.structures().to_vec());
    let before = snap(&m);
    let play = |m: &mut Match| {
        m.apply(Action::Mulligan).unwrap();
        sim_core::fixture::fixture_prep_plays(m);
        m.apply(Action::StartWave).unwrap();
        for t in 0..120 {
            if t == 30 {
                let [cx, cy] = m.center();
                if let Some(c) = m.hand().into_iter().find(|c| c.playable && c.target == TargetKind::Point) {
                    m.apply(Action::PlayCard { hand_index: c.hand_index, target: Target::Point([cx, cy]) }).unwrap();
                }
            }
            m.step();
        }
        m.state_hash()
    };
    let h1 = play(&mut m);
    assert_ne!(snap(&m), before);
    m.apply(Action::RetryWave).unwrap();
    assert_eq!(snap(&m), before, "hand, deck, discard, supply and structures restored");
    assert_eq!(m.state_hash(), prep);
    assert!(m.mulligan_available(), "the mulligan is available again");
    let h2 = play(&mut m);
    assert_eq!(h1, h2, "same actions after a retry: same draws, same wave");
    // Restart: back to the first hand.
    let first = starter(37).hand_ids().iter().map(|s| s.to_string()).collect::<Vec<_>>();
    m.apply(Action::RestartMatch).unwrap();
    assert_eq!(m.hand_ids().iter().map(|s| s.to_string()).collect::<Vec<_>>(), first);
    assert_eq!(m.state_hash(), starter(37).state_hash());
}

// ------------------------------------------------------------------ outbreaks

#[test]
fn outbreaks_scale_with_squeezed_rings() {
    let cfg = common::cfg();
    let full = Match::outbreak_counts(&cfg, &cfg.match_.ring_radius_m);
    let expect: Vec<(u32, u32)> = cfg.match_.outbreak_clusters.iter().zip(&cfg.match_.inner_outbreaks).map(|(&c, &i)| (c, i)).collect();
    assert_eq!(full, expect, "full-size rings keep the config counts");
    let rings = Match::ring_radii(&cfg, 400.0);
    let small = Match::outbreak_counts(&cfg, &rings);
    for (w, &(c, i)) in small.iter().enumerate() {
        let q = rings[w] / cfg.match_.ring_radius_m[w];
        let want = ((cfg.match_.outbreak_clusters[w] as f32 * q * q).round() as u32).max(1);
        assert_eq!(c, want, "wave {}", w + 1);
        assert!(i <= c);
    }
    assert!(small[7].0 < cfg.match_.outbreak_clusters[7]);
    let m = starter(38);
    assert_eq!((1..=8).map(|w| m.outbreak_count(w)).collect::<Vec<_>>(), small);
}

// ------------------------------------------------------------------ a whole match

#[test]
fn scripted_match_with_the_starter_deck() {
    // Every playable prep card each wave (fixture script), a tactical card
    // mid-wave, until the match ends or a wave is lost twice in a row.
    let cfg = common::cfg();
    let mc = cfg.match_.clone();
    let mut m = starter(39);
    let mut lost = 0;
    let mut attempts = Vec::new(); // (wave, won)
    let mut prev_end_hand: Option<usize> = None;
    let mut spent_total = 0u32;
    let mut earned_total = mc.supply_start + mc.supply_base_income;
    assert_eq!(m.supply(), earned_total);
    while m.phase() != Phase::MatchWon {
        // Hand size when the prep opens: 5 on wave 1, else up to 2 kept + 5.
        let expect_hand = prev_end_hand.map_or(5, |n| n.min(2) + 5);
        assert_eq!(m.hand_ids().len(), expect_hand, "wave {} prep hand", m.wave());
        assert_eq!(all_cards(&m).len(), 20);
        let (wave, supply0) = (m.wave(), m.supply());
        let ids0: Vec<u32> = m.structures().iter().map(|s| s.id).collect();
        sim_core::fixture::fixture_prep_plays(&mut m);
        let placed: Vec<_> = m.structures().iter().filter(|s| !ids0.contains(&s.id)).cloned().collect();
        assert!(placed.iter().all(|s| s.wave == wave));
        let cost: u32 = placed.iter().map(|s| s.cost).sum();
        assert_eq!(m.supply(), supply0 - cost, "wave {wave}: prep plays pay their cost");
        assert!(!placed.is_empty(), "wave {wave}: the script played something");
        // Nothing playable is left in prep that the supply could pay for.
        assert!(m.hand().iter().all(|c| !c.playable || c.kind == CardKind::Tactical));
        m.apply(Action::StartWave).unwrap();
        let mut tactical = 0;
        while m.phase() == Phase::Running {
            if m.wave_tick() == 40 {
                if let Some(c) = m.hand().into_iter().find(|c| c.playable && c.target == TargetKind::Point) {
                    let [cx, cy] = m.center();
                    if m.apply(Action::PlayCard { hand_index: c.hand_index, target: Target::Point([cx, cy]) }).is_ok() {
                        tactical += c.cost;
                    }
                }
            }
            m.step();
            assert!(m.wave_tick() < 20 * 1800, "wave {} stalled", m.wave());
        }
        assert_eq!(m.supply(), supply0 - cost - tactical);
        let r = m.results().last().unwrap().clone();
        assert_eq!((r.wave, r.cards_played as usize), (wave, placed.len() + (tactical > 0) as usize));
        attempts.push((wave, r.won));
        match m.phase() {
            Phase::WaveWon => {
                // Earned: base income + one supply per N civilians saved.
                let n = mc.supply_civilians_per_point[wave as usize - 1];
                assert_eq!(r.supply_earned, mc.supply_base_income + r.end_civilians / n, "wave {wave}");
                lost = 0;
                spent_total += cost + tactical;
                prev_end_hand = Some(m.hand_ids().len());
                let before = m.supply();
                m.apply(Action::NextWave).unwrap();
                let inc = m.supply_income();
                assert_eq!(inc.base + inc.civilians, r.supply_earned);
                assert_eq!(m.supply(), before + r.supply_earned, "wave {}: unspent supply carries over", wave + 1);
                earned_total += r.supply_earned;
                assert_eq!(m.supply(), earned_total - spent_total);
            }
            Phase::WaveLost if lost < 2 => {
                assert_eq!(r.supply_earned, 0);
                lost += 1;
                m.apply(Action::RetryWave).unwrap();
                // The retry restores the prep: same supply and hand as it opened with.
                assert_eq!(m.supply(), supply0);
            }
            Phase::MatchWon => {
                assert_eq!(r.supply_earned, 0, "wave 8 earns nothing");
                spent_total += cost + tactical;
            }
            _ => break,
        }
    }
    // Seed 39 with this script: every wave held on the first try.
    assert_eq!(attempts, (1..=8).map(|w| (w, true)).collect::<Vec<_>>());
    assert_eq!(m.phase(), Phase::MatchWon);
    assert_eq!(m.results().len(), 8);
    let played: Vec<u32> = m.results().iter().map(|r| r.cards_played).collect();
    // Was [5, 5, 3, 4, 3, 4, 4, 3] before the match grid's margin grew to
    // `ring_band_m` + one cell (second T2 review): the grid origin, so every
    // sim coordinate, moved and the play diverges from wave 3.
    assert_eq!(played, vec![5, 5, 4, 3, 3, 3, 4, 3], "cards played per wave");
    let total: u32 = m.deck_count() + m.discard_count() + m.hand_ids().len() as u32;
    assert_eq!(total, 20);
}

// ------------------------------------------------------------------ review fixes

fn owned(v: Vec<&str>) -> Vec<String> {
    v.into_iter().map(|s| s.to_string()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[test]
fn an_empty_keep_choice_keeps_nothing() {
    // Explicit empty choice in prep: the whole hand is discarded.
    let mut m = starter(5);
    let hand = owned(m.hand_ids());
    let h_none = m.state_hash();
    m.apply(Action::KeepCards { hand_indices: vec![] }).unwrap();
    assert_ne!(m.state_hash(), h_none, "the choice is part of the state");
    fast_win(&mut m, 10);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(m.hand_ids().len(), 5, "kept nothing, drew 5");
    assert_eq!(owned(m.discard_ids()), hand, "the whole hand went to the discard, in hand order");
    // The choice lasts one prep: next wave, no choice, the first two stay.
    let hand2 = owned(m.hand_ids());
    fast_win(&mut m, 10);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(owned(m.hand_ids())[..2], hand2[..2]);
    assert_eq!(m.hand_ids().len(), 7);
    // An empty choice made on the result screen counts too, and the last choice wins.
    m.apply(Action::KeepCards { hand_indices: vec![0, 1] }).unwrap();
    fast_win(&mut m, 10);
    m.apply(Action::KeepCards { hand_indices: vec![] }).unwrap();
    m.apply(Action::NextWave).unwrap();
    assert_eq!(m.hand_ids().len(), 5);
}

#[test]
fn a_mulligan_on_an_empty_deck_draws_from_the_reshuffled_discard() {
    // Starter deck: 20 cards, 5 drawn per prep, so wave 4's draw empties it.
    let mut m = starter(5);
    for _ in 1..=3 {
        fast_win(&mut m, 10);
        m.apply(Action::NextWave).unwrap();
    }
    assert_eq!((m.wave(), m.deck_count(), m.discard_count(), m.hand_ids().len()), (4, 0, 13, 7));
    let old = owned(m.hand_ids());
    let discard = sorted(owned(m.discard_ids()));
    let (supply, reshuffles) = (m.supply(), m.reshuffles());
    m.apply(Action::Mulligan).unwrap();
    assert_eq!(m.supply(), supply - m.mulligan_cost());
    assert_eq!(m.reshuffles(), reshuffles + 1, "the discard was shuffled into the deck");
    let new = owned(m.hand_ids());
    assert_eq!(new.len(), 7);
    // The new hand comes from the old discard only...
    let mut rest = discard.clone();
    for c in &new {
        let p = rest.iter().position(|d| d == c).unwrap_or_else(|| panic!("{c} not from the discard {discard:?}"));
        rest.remove(p);
    }
    // ...and the old hand sits at the bottom of the deck, first card lowest,
    // under the 6 discard cards not drawn.
    let deck = owned(m.debug_deck_ids());
    assert_eq!((deck.len(), m.discard_count()), (13, 0));
    assert_eq!(deck.iter().rev().take(7).cloned().collect::<Vec<_>>(), old);
    assert_eq!(sorted(deck[..6].to_vec()), sorted(rest));
    assert_eq!(all_cards(&m), sorted(m.deck_list().to_vec()));
    // Deterministic: same seed, same mulligan draw (DECK stream of wave 4).
    let mut m2 = starter(5);
    for _ in 1..=3 {
        fast_win(&mut m2, 10);
        m2.apply(Action::NextWave).unwrap();
    }
    m2.apply(Action::Mulligan).unwrap();
    assert_eq!(m2.state_hash(), m.state_hash());
    // A short deck (fewer cards than the hand) also draws the rest from the
    // reshuffled discard before any old card: probe every prep of a match.
    let mut short_decks = 0;
    for seed in 1..=4u64 {
        let mut p = starter(seed);
        for _ in 1..8 {
            let (deck_n, hand_n) = (p.deck_count() as usize, p.hand_ids().len());
            if deck_n < hand_n && p.mulligan_available() {
                short_decks += (deck_n > 0) as u32;
                let (before, top) = (owned(p.hand_ids()), owned(p.debug_deck_ids()));
                let discard = sorted(owned(p.discard_ids()));
                p.apply(Action::Mulligan).unwrap();
                let new = owned(p.hand_ids());
                assert_eq!(new[..deck_n], top[..], "seed {seed}: the deck's cards first");
                let mut pool = discard.clone();
                for c in &new[deck_n..] {
                    let k = pool.iter().position(|d| d == c).unwrap_or_else(|| panic!("seed {seed}: {c} not from the discard"));
                    pool.remove(k);
                }
                assert_eq!(owned(p.debug_deck_ids()).iter().rev().take(before.len()).cloned().collect::<Vec<_>>(), before);
            }
            fast_win(&mut p, 5);
            p.apply(Action::NextWave).unwrap();
        }
    }
    assert!(short_decks > 0, "the probe met a deck with fewer cards than the hand");
}

#[test]
fn pulling_down_a_fence_gives_taken_over_cells_back() {
    let cfg = common::cfg();
    let mut m = match_with(cfg, ids(&[("light_fence", 10), ("barbed_wire", 10)]), 40);
    let [cx, cy] = m.center();
    let line = vec![[cx - 20.0, cy - 50.0], [cx + 20.0, cy - 50.0]];
    while !m.hand_ids().contains(&"light_fence") {
        m.apply(Action::Mulligan).unwrap();
    }
    m.apply(Action::PlayCard { hand_index: hand_index_of(&m, "light_fence"), target: Target::Polyline(line.clone()) }).unwrap();
    let fence = m.structures()[0].clone();
    let StructureKind::Fence { cells, cell_hp, .. } = fence.kind.clone() else { panic!() };
    assert!(cells.len() > 4);
    fast_win(&mut m, 5);
    m.apply(Action::NextWave).unwrap();
    if !m.hand_ids().contains(&"barbed_wire") {
        m.apply(Action::Mulligan).unwrap();
    }
    // Break the first cell, then draw barbed wire over it: it takes the cell over.
    {
        let s = m.debug_sim_mut();
        s.debug_break_fence_cell(cells[0] as usize);
    }
    let before = m.structures().to_vec();
    let repair = m.repair_cost(fence.id);
    assert!(repair.is_some());
    m.apply(Action::PlayCard { hand_index: hand_index_of(&m, "barbed_wire"), target: Target::Polyline(line.clone()) }).unwrap();
    let wire = m.structures()[1].clone();
    let StructureKind::Fence { cells: wc, taken_over, .. } = &wire.kind else { panic!() };
    assert_eq!(wc, &vec![cells[0]]);
    assert_eq!(taken_over, &vec![TakenCell { cell: cells[0], from: fence.id, index: 0 }]);
    let StructureKind::Fence { cells: left, .. } = &m.structures()[0].kind else { panic!() };
    assert_eq!(left[..], cells[1..], "the old fence lost the cell");
    // Same-prep pull-down: the cell is broken again and back with its old fence, at its place.
    m.apply(Action::PullDown { placement_id: wire.id }).unwrap();
    assert_eq!(m.structures(), &before[..]);
    assert_eq!((m.sim().grid.kind[cells[0] as usize], m.sim().grid.fence_hp[cells[0] as usize]), (WALK, 0.0));
    assert_eq!(m.repair_cost(fence.id), repair, "the gap can be repaired again");
    m.apply(Action::Repair { fence_id: fence.id }).unwrap();
    assert!(cells.iter().all(|&c| m.sim().grid.kind[c as usize] == FENCE && m.sim().grid.fence_hp[c as usize] == cell_hp));

    // An older fence pulled down later also gives back the cells it still holds.
    {
        let s = m.debug_sim_mut();
        s.debug_break_fence_cell(cells[1] as usize);
    }
    m.apply(Action::PlayCard { hand_index: hand_index_of(&m, "barbed_wire"), target: Target::Polyline(line) }).unwrap();
    let wire = m.structures()[1].clone();
    let h_taken = m.state_hash();
    fast_win(&mut m, 5);
    m.apply(Action::NextWave).unwrap();
    assert_ne!(h_taken, m.state_hash());
    m.apply(Action::PullDown { placement_id: wire.id }).unwrap();
    let StructureKind::Fence { cells: back, .. } = &m.structures()[0].kind else { panic!() };
    assert_eq!(back, &cells);
}

/// Break cell `c` (open ground, 0 hp), as a lost fight would.
fn break_cell(m: &mut Match, c: u32) {
    let s = m.debug_sim_mut();
    s.debug_break_fence_cell(c as usize);
}

#[test]
fn a_cell_taken_over_twice_goes_back_whatever_the_pull_down_order() {
    for b_first in [true, false] {
        let mut m = mono("light_fence", 40);
        let [cx, cy] = m.center();
        let line = vec![[cx - 20.0, cy - 50.0], [cx + 20.0, cy - 50.0]];
        // Wave 1: fence A; its first cell X breaks.
        m.apply(Action::PlayCard { hand_index: 0, target: Target::Polyline(line.clone()) }).unwrap();
        let a = m.structures()[0].clone();
        let StructureKind::Fence { cells, .. } = a.kind.clone() else { panic!() };
        let x = cells[0];
        fast_win(&mut m, 5);
        break_cell(&mut m, x);
        m.apply(Action::NextWave).unwrap();
        // Wave 2: B over X, and X breaks again.
        m.apply(Action::PlayCard { hand_index: 0, target: Target::Polyline(line.clone()) }).unwrap();
        let b = m.structures()[1].id;
        assert_eq!(m.structure_at_cell(x).map(|s| s.id), Some(b));
        fast_win(&mut m, 5);
        break_cell(&mut m, x);
        m.apply(Action::NextWave).unwrap();
        // Wave 3: C over X.
        m.apply(Action::PlayCard { hand_index: 0, target: Target::Polyline(line.clone()) }).unwrap();
        let c = m.structures()[2].id;
        assert_eq!(m.structure_at_cell(x).map(|s| s.id), Some(c));
        let order = if b_first { [b, c] } else { [c, b] };
        m.apply(Action::PullDown { placement_id: order[0] }).unwrap();
        m.apply(Action::PullDown { placement_id: order[1] }).unwrap();
        // X is A's again, broken, in its place, and A can repair it.
        assert_eq!(m.structures().len(), 1);
        assert_eq!(m.structure_at_cell(x).map(|s| s.id), Some(a.id), "b_first {b_first}");
        let StructureKind::Fence { cells: back, .. } = &m.structures()[0].kind else { panic!() };
        assert_eq!(back, &cells, "b_first {b_first}");
        assert_eq!((m.sim().grid.kind[x as usize], m.sim().grid.fence_hp[x as usize]), (WALK, 0.0));
        assert!(m.repair_cost(a.id).is_some(), "b_first {b_first}");
        m.apply(Action::Repair { fence_id: a.id }).unwrap();
        assert_eq!(m.sim().grid.kind[x as usize], FENCE);
    }
}

#[test]
fn a_mulligan_drops_an_earlier_keep_choice() {
    // The keep marks pointed into the old hand: after a mulligan the default
    // (first two stay) applies again.
    let mut m = starter(5);
    m.apply(Action::KeepCards { hand_indices: vec![0, 1] }).unwrap();
    m.apply(Action::Mulligan).unwrap();
    assert!(m.hand().iter().all(|c| !c.keep));
    let mut plain = starter(5);
    plain.apply(Action::Mulligan).unwrap();
    assert_eq!(m.state_hash(), plain.state_hash(), "no trace of the old choice");
    fast_win(&mut m, 10);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(m.hand_ids().len(), 7);
    // A choice made after the mulligan still counts.
    let mut k = starter(5);
    k.apply(Action::Mulligan).unwrap();
    k.apply(Action::KeepCards { hand_indices: vec![] }).unwrap();
    fast_win(&mut k, 10);
    k.apply(Action::NextWave).unwrap();
    assert_eq!(k.hand_ids().len(), 5);
}

#[test]
fn huge_fence_coordinates_are_refused_quickly() {
    let mut m = mono("light_fence", 41);
    let [cx, cy] = m.center();
    for far in [1e12f32, 1e30, -1e30, f32::MAX] {
        for pts in [vec![[cx, cy], [far, cy]], vec![[far, cy], [cx, cy]], vec![[cx, cy], [cx, far]]] {
            let t = std::time::Instant::now();
            let e = m.apply(Action::PlayCard { hand_index: 0, target: Target::Polyline(pts.clone()) }).unwrap_err();
            assert!(matches!(&e, ActionError::Placement { reason } if reason.contains("on the map")), "{e}");
            assert!(m.fence_length_m(&pts).is_err());
            assert!(t.elapsed() < std::time::Duration::from_millis(10), "{far}: {:?}", t.elapsed());
        }
    }
    // On the map but absurdly long as drawn (a zigzag): refused before rasterizing.
    let zig: Vec<[f32; 2]> = (0..400).map(|k| [cx + if k % 2 == 0 { -100.0 } else { 100.0 }, cy + 0.01 * k as f32]).collect();
    let t = std::time::Instant::now();
    let e = m.apply(Action::PlayCard { hand_index: 0, target: Target::Polyline(zig) }).unwrap_err();
    assert!(matches!(&e, ActionError::Placement { reason } if reason.contains("as drawn")), "{e}");
    assert!(t.elapsed() < std::time::Duration::from_millis(10), "{:?}", t.elapsed());
    assert!(m.structures().is_empty() && m.log().is_empty());
}

#[test]
fn card_state_is_in_the_state_hash() {
    // Wave 2's prep: 7 in hand, 10 in the deck, 3 in the discard.
    let base = || {
        let mut m = starter(42);
        fast_win(&mut m, 5);
        m.apply(Action::NextWave).unwrap();
        m
    };
    let h0 = base().state_hash();
    assert_eq!(h0, base().state_hash());
    let m = base();
    let differing = |v: &[&str]| -> (usize, usize) {
        let j = v.iter().position(|c| *c != v[0]).expect("two different cards");
        (0, j)
    };
    let (hi, hj) = differing(&m.hand_ids());
    let deck = m.debug_deck_ids();
    let (di, dj) = differing(&deck);
    let (di, dj) = (deck.len() - 1 - di, deck.len() - 1 - dj); // raw: next card last
    let (xi, xj) = differing(&m.discard_ids());
    let edits = [
        ("supply", DebugCardEdit::Supply(m.supply() + 1)),
        ("hand order", DebugCardEdit::SwapHand(hi, hj)),
        ("deck order", DebugCardEdit::SwapDeck(di, dj)),
        ("discard order", DebugCardEdit::SwapDiscard(xi, xj)),
        ("keep mark", DebugCardEdit::Keep(0, true)),
        ("keep choice", DebugCardEdit::KeepChosen(true)),
        ("mulligan flag", DebugCardEdit::MulliganUsed(true)),
    ];
    for (name, e) in edits {
        let mut m = base();
        m.debug_edit_cards(e);
        assert_ne!(m.state_hash(), h0, "{name} must change the hash");
    }
    // Same through actions: two keep choices differing in one mark.
    let (mut a, mut b) = (base(), base());
    a.apply(Action::KeepCards { hand_indices: vec![0] }).unwrap();
    b.apply(Action::KeepCards { hand_indices: vec![1] }).unwrap();
    assert_ne!(a.state_hash(), b.state_hash());
    // Discard content (not just order): play a card on each, then undo one.
    let (mut a, mut b) = (base(), base());
    for m in [&mut a, &mut b] {
        let c = m.hand().into_iter().find(|c| c.playable && c.kind == CardKind::Armament).expect("an armament");
        m.apply(Action::PlayCard { hand_index: c.hand_index, target: Target::Buildings(free_buildings(m, 1)) }).unwrap();
    }
    assert_eq!(a.state_hash(), b.state_hash());
    let id = a.structures()[0].id;
    a.apply(Action::PullDown { placement_id: id }).unwrap();
    assert_ne!(a.state_hash(), b.state_hash());
}
