//! `export_engine_abi!` and `buffer!` end to end on a small world, calling the
//! exported C functions and reading buffers through raw pointers the way
//! JavaScript does. (An integration test is its own crate root, which is where
//! the macros must be invoked.)

use vgd_engine::clock::{FixedStep, DT};
use vgd_engine::events::{Events, EVENT_FLOATS};
use vgd_engine::Sim;

mod params {
    vgd_engine::params! {
        0 RATE = 2.0;
        1 LIMIT = 10.0;
    }
}

const EV_STARTED: f32 = 1.0;
const OUT_FLOATS: usize = 3;

struct World {
    p: [f32; params::COUNT],
    seed: u32,
    clock: FixedStep,
    events: Events,
    paused: bool,
    playing: bool,
    time: f32,
    out: [f32; OUT_FLOATS],
}

impl World {
    fn write_outputs(&mut self) {
        self.out = [self.time, self.playing as u8 as f32, self.p[params::RATE]];
    }
}

impl Sim for World {
    const ABI_VERSION: u32 = 7;
    const PARAM_DEFAULTS: &'static [f32] = &params::DEFAULTS;

    fn new(seed: u32) -> Self {
        let mut w = World { p: params::DEFAULTS, seed, clock: FixedStep::default(), events: Events::default(), paused: false, playing: false, time: 0.0, out: [0.0; OUT_FLOATS] };
        w.write_outputs();
        w
    }
    fn reset(&mut self) {
        self.clock.clear();
        self.events.clear();
        self.paused = false;
        self.playing = false;
        self.time = 0.0;
        self.write_outputs();
    }
    fn advance(&mut self, real_dt: f32) -> u32 {
        if self.paused {
            return 0;
        }
        let n = self.clock.feed(real_dt);
        if self.playing {
            self.time += n as f32 * DT;
        }
        self.write_outputs();
        n
    }
    fn set_paused(&mut self, on: bool) {
        self.paused = on;
        if on {
            self.clock.clear();
        }
    }
    fn round_start(&mut self) {
        if !self.playing {
            self.playing = true;
            self.events.emit(EV_STARTED, self.seed as f32, 0.0, 0.0, 0.0, 0.0);
            self.write_outputs();
        }
    }
    fn params(&mut self) -> &mut [f32] {
        &mut self.p
    }
    fn events(&mut self) -> &mut Events {
        &mut self.events
    }
    fn params_changed(&mut self) {
        self.write_outputs();
    }
}

vgd_engine::export_engine_abi!(World);
vgd_engine::buffer!(buf_out, buf_out_count, buf_out_stride, OUT_FLOATS, |w| w.out[..]);

fn out() -> Vec<f32> {
    let n = buf_out_count() as usize * buf_out_stride() as usize;
    unsafe { std::slice::from_raw_parts(buf_out(), n) }.to_vec()
}

fn events() -> Vec<f32> {
    let n = buf_events_count() as usize * EVENT_FLOATS;
    unsafe { std::slice::from_raw_parts(buf_events(), n) }.to_vec()
}

#[test]
fn engine_exports_drive_any_world() {
    assert_eq!(sim_engine_version(), vgd_engine::ENGINE_ABI_VERSION);
    assert_eq!(sim_abi_version(), 7);
    sim_init(42);
    assert_eq!(buf_events_stride() as usize, EVENT_FLOATS);
    assert_eq!((buf_out_count(), buf_out_stride()), (1, OUT_FLOATS as u32));

    // Params: count, defaults, live set (outputs rewritten), NaN and unknown ids ignored.
    assert_eq!(sim_param_count(), 2);
    assert_eq!(sim_param_default(1), 10.0);
    assert_eq!(sim_param_get(0), 2.0);
    sim_param_set(0, 3.5);
    assert_eq!((sim_param_get(0), out()[2]), (3.5, 3.5));
    sim_param_set(0, f32::NAN);
    assert_eq!(sim_param_get(0), 3.5, "non-finite values are rejected");
    sim_param_set(9, 1.0);
    assert_eq!((sim_param_get(9), sim_param_default(9)), (0.0, 0.0));

    // Round start emits the game's event into the engine's events buffer.
    sim_round_start();
    assert_eq!(events(), vec![EV_STARTED, 42.0, 0.0, 0.0, 0.0, 0.0]);
    sim_clear_frame();
    assert_eq!(buf_events_count(), 0);

    // Fixed steps: 60 frames of 1/60 s are 120 steps; paused frames take none.
    let steps: u32 = (0..60).map(|_| sim_advance(1.0 / 60.0)).sum();
    assert_eq!(steps, 120);
    assert!((out()[0] - 1.0).abs() < 1e-4);
    sim_set_paused(1);
    assert_eq!(sim_advance(0.05), 0);
    sim_set_paused(0);
    assert!(sim_advance(0.05) > 0);

    // Reset keeps tuning; init replaces the world.
    sim_reset();
    assert_eq!((out()[0], out()[1], sim_param_get(0)), (0.0, 0.0, 3.5));
    sim_init(1);
    assert_eq!(sim_param_get(0), 2.0);
}
