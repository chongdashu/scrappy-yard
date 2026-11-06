//! Live-tunable parameters for the scrapyard greybox gym. The DEV tuning panel
//! (T on the dev server) shows each one with the label and slider range in
//! `game/src/sim-abi.ts` (`PARAMS`). Append new ids; don't renumber (saved
//! tunings refer to ids). Values are proposals for the gym, not final tuning.

vgd_engine::params! {
    0 RUN_SPEED = 8.0;          // m/s forward (+Z) at full run
    1 LANE_WIDTH = 1.4;         // m between lane centres (three lanes)
    2 LANE_SWITCH_TIME = 0.13;  // s to cross one lane
    3 JUMP_SPEED = 7.6;         // m/s upward on take-off
    4 GRAVITY = 24.0;           // m/s² while airborne
    5 MECH_GAP_START = 12.0;    // m between player and mech at the start (comfort gap)
    6 MECH_GAP_END = 7.0;       // m comfort gap by the finish (the mech closes in)
    7 MECH_RECOVER = 0.6;       // m/s the gap reopens toward the comfort gap
    8 MECH_CATCH_GAP = 1.6;     // m: gap at or below this = caught
    9 STUMBLE_TIME = 0.7;       // s of slowed running after hitting a barrel
    10 STUMBLE_SPEED = 0.4;     // × RUN_SPEED while stumbling
    11 COURSE_LENGTH = 800.0;   // m from start to the finish gate (was 420; longer runs, 2026-11-05)
    12 PRACTICE = 0.0;          // 1 = nothing is lethal (gym/test aid): crashes stumble, falls pop back up, the mech can't catch
    13 PLAYER_HALF_WIDTH = 0.32;// m, collision half-width (x)
    14 PLAYER_HEIGHT = 1.1;     // m, collision height
    15 COYOTE_TIME = 0.08;      // s after leaving the floor a jump still works
    16 JUMP_BUFFER = 0.12;      // s a jump press waits for the floor
    17 STRAFE_SPEED = 6.5;      // m/s sideways while a direction is held (≈0.22 s per lane)
    18 STRAFE_ACCEL = 60.0;     // m/s² toward the held strafe speed (release brakes at 1.5×)
    19 STRAFE_MARGIN = 0.55;    // m the player may slide past the outer lane centres (deck edge)
    20 SURGE_EVERY = 85.0;      // m of course between mech surges (pressure beats); 0 = none
    21 SURGE_DEPTH = 4.0;       // m the comfort gap dips at a surge's peak
    22 SURGE_RATE = 1.8;        // m/s the mech closes on the dipped gap during a surge
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_dense_and_stable() {
        for (i, id) in IDS.iter().enumerate() {
            assert_eq!(i, *id);
        }
        assert_eq!(COUNT, 23);
        assert_eq!(DEFAULTS[RUN_SPEED], 8.0);
    }
}
