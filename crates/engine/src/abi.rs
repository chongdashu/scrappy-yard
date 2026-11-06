//! The engine side of the C ABI: what a game's world must provide ([`Sim`]),
//! where the single world instance lives ([`Slot`]), and the macros that
//! export the engine's functions and the game's output buffers.
//!
//! A game crate's `lib.rs` (its crate root) looks like this (an outline: it
//! needs the game's `world` module, so it is not compiled as a doctest):
//!
//! ```text
//! pub mod world;
//! use world::*;
//!
//! vgd_engine::export_engine_abi!(World);
//! vgd_engine::buffer!(buf_stats, buf_stats_count, buf_stats_stride, STATS_FLOATS, |w| w.out_stats[..]);
//!
//! #[no_mangle]
//! pub extern "C" fn sim_set_input(move_x: f32, move_z: f32) {
//!     world().input = Input { move_x, move_z };
//! }
//! ```
//!
//! `export_engine_abi!` must be invoked at the crate root: it defines
//! `pub fn world()` there, and `buffer!` calls `crate::world()`.

use std::cell::UnsafeCell;

use crate::events::Events;

/// What the engine needs from a game's world. The game keeps its own rules,
/// state and output buffers; the engine drives the lifecycle through these.
pub trait Sim: Sized + 'static {
    /// The game's ABI layout version (`sim_abi_version()`). Bump it when any
    /// game export, stride, index or event meaning changes; the game's
    /// `src/sim-abi.ts` must carry the same number (checked at boot).
    const ABI_VERSION: u32;
    /// Defaults of the params table (`params!` → `DEFAULTS`); may be empty.
    const PARAM_DEFAULTS: &'static [f32];

    /// A fresh world for `seed` (same seed + same inputs ⇒ same run).
    fn new(seed: u32) -> Self;
    /// Back to the authored round, READY. Tunable params are kept.
    fn reset(&mut self);
    /// Advance by real elapsed seconds in fixed steps (see `clock::FixedStep`);
    /// write outputs once per call. Returns the steps taken (0 while paused).
    fn advance(&mut self, real_dt: f32) -> u32;
    /// Freeze (true) or resume the simulation clock.
    fn set_paused(&mut self, on: bool);
    /// READY → PLAYING (the front end's countdown says GO). No-op otherwise.
    fn round_start(&mut self);
    /// The live params table (`sim_param_get/set`).
    fn params(&mut self) -> &mut [f32];
    /// This frame's events (`buf_events`).
    fn events(&mut self) -> &mut Events;
    /// A param changed live: rewrite any output that depends on it.
    fn params_changed(&mut self) {}
    /// JavaScript has read this frame's events.
    fn clear_frame(&mut self) {
        self.events().clear();
    }
}

/// The single world instance of a wasm module.
///
/// wasm32-unknown-unknown without threads runs on one thread, so an
/// unsynchronized cell is sound there. Native tests should use world values
/// directly; at most one test per crate may drive the exported functions
/// (cargo runs tests on parallel threads).
pub struct Slot<T>(UnsafeCell<Option<Box<T>>>);

// SAFETY: see above; the exported functions are never called concurrently.
unsafe impl<T> Sync for Slot<T> {}

impl<T> Slot<T> {
    pub const fn new() -> Self {
        Slot(UnsafeCell::new(None))
    }

    /// Create or replace the instance.
    pub fn set(&'static self, value: T) {
        // SAFETY: single-threaded access (see `Slot`).
        unsafe { *self.0.get() = Some(Box::new(value)) };
    }

    /// The instance. Panics (a wasm trap) before `set`.
    #[allow(clippy::mut_from_ref)]
    pub fn get(&'static self) -> &'static mut T {
        // SAFETY: single-threaded access (see `Slot`); no reference outlives one exported call.
        unsafe { (*self.0.get()).as_deref_mut().expect("sim_init not called") }
    }
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// Export `ptr`, `count` and `stride` functions for one output buffer: an f32
/// slice of whole records, read through `crate::world()`.
///
/// `buffer!(buf_player, buf_player_count, buf_player_stride, PLAYER_FLOATS, |w| w.out_player[..]);`
#[macro_export]
macro_rules! buffer {
    ($ptr:ident, $count:ident, $stride_fn:ident, $stride:expr, |$w:ident| $slice:expr) => {
        #[no_mangle]
        pub extern "C" fn $ptr() -> *const f32 {
            let $w = crate::world();
            $slice.as_ptr()
        }
        #[no_mangle]
        pub extern "C" fn $count() -> u32 {
            let $w = crate::world();
            ($slice.len() / $stride) as u32
        }
        #[no_mangle]
        pub extern "C" fn $stride_fn() -> u32 {
            $stride as u32
        }
    };
}

/// Export the engine's C functions for a world type that implements [`Sim`],
/// and define `pub fn world()` (the single instance) at the crate root.
///
/// Exports: `sim_engine_version`, `sim_abi_version`, `sim_init(seed)`,
/// `sim_reset`, `sim_advance(dt) → steps`, `sim_set_paused(on)`,
/// `sim_clear_frame`, `sim_round_start`, `sim_param_count/get/set/default`
/// and the `events` buffer (`buf_events`, `_count`, `_stride`).
#[macro_export]
macro_rules! export_engine_abi {
    ($world:ty) => {
        static VGD_WORLD: $crate::Slot<$world> = $crate::Slot::new();

        /// The single world instance (`sim_init` must have run).
        pub fn world() -> &'static mut $world {
            VGD_WORLD.get()
        }

        #[no_mangle]
        pub extern "C" fn sim_engine_version() -> u32 {
            $crate::ENGINE_ABI_VERSION
        }

        #[no_mangle]
        pub extern "C" fn sim_abi_version() -> u32 {
            <$world as $crate::Sim>::ABI_VERSION
        }

        /// Create (or replace) the world. A fresh page load is the only way to
        /// get a fresh wasm instance; call this again to drop all state within one.
        #[no_mangle]
        pub extern "C" fn sim_init(seed: u32) {
            VGD_WORLD.set(<$world as $crate::Sim>::new(seed));
        }

        #[no_mangle]
        pub extern "C" fn sim_reset() {
            $crate::Sim::reset(world());
        }

        /// Advance by real elapsed seconds in fixed 1/120 s steps (clamped to
        /// 0.1 s, at most 12 steps). Returns the number of steps taken (0 while paused).
        #[no_mangle]
        pub extern "C" fn sim_advance(dt: f32) -> u32 {
            $crate::Sim::advance(world(), dt)
        }

        /// Freeze (1) or resume (0) the simulation clock.
        #[no_mangle]
        pub extern "C" fn sim_set_paused(on: u32) {
            $crate::Sim::set_paused(world(), on != 0);
        }

        /// Drop this frame's events once JavaScript has read them.
        #[no_mangle]
        pub extern "C" fn sim_clear_frame() {
            $crate::Sim::clear_frame(world());
        }

        /// READY → PLAYING (the front end calls this when its countdown says GO).
        #[no_mangle]
        pub extern "C" fn sim_round_start() {
            $crate::Sim::round_start(world());
        }

        #[no_mangle]
        pub extern "C" fn sim_param_count() -> u32 {
            <$world as $crate::Sim>::PARAM_DEFAULTS.len() as u32
        }

        #[no_mangle]
        pub extern "C" fn sim_param_get(id: u32) -> f32 {
            $crate::Sim::params(world()).get(id as usize).copied().unwrap_or(0.0)
        }

        /// Set a param live. Non-finite values and unknown ids are ignored.
        #[no_mangle]
        pub extern "C" fn sim_param_set(id: u32, v: f32) {
            if !v.is_finite() {
                return;
            }
            let w = world();
            if let Some(p) = $crate::Sim::params(w).get_mut(id as usize) {
                *p = v;
                $crate::Sim::params_changed(w);
            }
        }

        #[no_mangle]
        pub extern "C" fn sim_param_default(id: u32) -> f32 {
            <$world as $crate::Sim>::PARAM_DEFAULTS.get(id as usize).copied().unwrap_or(0.0)
        }

        $crate::buffer!(buf_events, buf_events_count, buf_events_stride, $crate::events::EVENT_FLOATS, |w| $crate::Sim::events(w).buf[..]);
    };
}
