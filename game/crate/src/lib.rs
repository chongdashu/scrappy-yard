//! The scrapyard greybox gym's simulation, compiled to `sim.wasm`. Rules are
//! in `world.rs`; the engine (`vgd_engine`, crates/engine) supplies the
//! fixed-step clock, events, params and the lifecycle exports.
//!
//! Every export, stride, index and event kind is mirrored in
//! `game/src/sim-abi.ts`; bump `world::ABI_VERSION` (and the mirror) whenever
//! one of them changes, and the page refuses a stale `sim.wasm`.

pub mod params;
pub mod world;

use world::*;

vgd_engine::export_engine_abi!(World);

vgd_engine::buffer!(buf_stats, buf_stats_count, buf_stats_stride, STATS_FLOATS, |w| w.out_stats[..]);
vgd_engine::buffer!(buf_player, buf_player_count, buf_player_stride, PLAYER_FLOATS, |w| w.out_player[..]);
vgd_engine::buffer!(buf_obstacles, buf_obstacles_count, buf_obstacles_stride, OBSTACLE_FLOATS, |w| w.out_obstacles[..]);
vgd_engine::buffer!(buf_nuts, buf_nuts_count, buf_nuts_stride, NUT_FLOATS, |w| w.out_nuts[..]);

/// A lane nudge: slide to the next lane centre left (dir < 0) or right (dir > 0),
/// screen-relative: left is −X. A tap/flick; held movement goes through `sim_strafe`.
#[no_mangle]
pub extern "C" fn sim_lane(dir: i32) {
    world().lane(dir);
}

/// The held sideways axis, −1 (screen-left, −X) … +1; 0 = released (the player stops where it is).
#[no_mangle]
pub extern "C" fn sim_strafe(axis: f32) {
    world().strafe(axis);
}

/// A jump press (buffered briefly until the floor allows it).
#[no_mangle]
pub extern "C" fn sim_jump() {
    world().jump();
}

/// 0 = gym (rules run), 1 = asset viewer (no rules).
#[no_mangle]
pub extern "C" fn sim_set_mode(mode: u32) {
    world().set_mode(mode as u8);
}

#[cfg(test)]
mod tests {
    use super::*;
    use vgd_engine::events::EVENT_FLOATS;

    #[test]
    fn abi_roundtrip() {
        assert_eq!(sim_abi_version(), ABI_VERSION);
        assert_eq!(sim_engine_version(), vgd_engine::ENGINE_ABI_VERSION);
        sim_init(5);
        assert_eq!((buf_stats_count(), buf_stats_stride() as usize), (1, STATS_FLOATS));
        assert_eq!((buf_player_count(), buf_player_stride() as usize), (1, PLAYER_FLOATS));
        assert!(buf_obstacles_count() > 10 && buf_nuts_count() > 10);
        assert_eq!(buf_events_stride() as usize, EVENT_FLOATS);
        assert_eq!(sim_param_count() as usize, params::COUNT);
        let stats = || unsafe { std::slice::from_raw_parts(buf_stats(), STATS_FLOATS) }.to_vec();
        assert_eq!(stats()[ST_STATE], STATE_READY as f32);

        sim_round_start();
        let ev = unsafe { std::slice::from_raw_parts(buf_events(), buf_events_count() as usize * EVENT_FLOATS) };
        assert_eq!(ev[0], EV_ROUND_START);
        sim_clear_frame();
        sim_lane(-1);
        sim_jump();
        let steps: u32 = (0..60).map(|_| sim_advance(1.0 / 60.0)).sum();
        assert_eq!(steps, 120);
        let pl = unsafe { std::slice::from_raw_parts(buf_player(), PLAYER_FLOATS) }.to_vec();
        assert_eq!(pl[PL_LANE], -1.0);
        assert!(pl[PL_Z] > 7.0);
        assert_eq!(stats()[ST_STATE], STATE_PLAYING as f32);
        sim_set_paused(1);
        assert_eq!(sim_advance(0.05), 0);
        sim_set_paused(0);
        sim_reset();
        assert_eq!(stats()[ST_STATE], STATE_READY as f32);
    }
}
