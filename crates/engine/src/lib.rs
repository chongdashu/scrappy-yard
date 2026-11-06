//! Game-neutral simulation engine. A game crate (the active game's `crate/`)
//! owns the rules; this crate owns what every game's simulation shares:
//!
//! - [`clock`]: the fixed 120 Hz step, clamped hitches, the leftover fraction
//! - [`events`]: flat per-frame event records JavaScript reads
//! - [`math`]: ground-plane conventions and a deterministic RNG
//! - [`interp`]: the drawn pose between fixed steps (see `DrawnPose`)
//! - [`params!`]: an id-stable table of live-tunable f32 parameters
//! - [`abi`]: the [`Sim`] trait and the macros that export the C ABI
//!   ([`export_engine_abi!`], [`buffer!`])
//!
//! Rust owns every gameplay value; JavaScript reads flat f32 buffers through a
//! plain C ABI and renders them. No wasm-bindgen: the module imports nothing
//! and exports only functions and its memory.
//!
//! ABI rules (loaded and checked by `src/wasm.ts`; each game mirrors its own
//! layout in its `src/sim-abi.ts`):
//! - `sim_engine_version()` must equal the page's `ENGINE_ABI_VERSION` and
//!   `sim_abi_version()` the game's `SIM_ABI_VERSION`; the page refuses to
//!   start on a mismatch (a stale `sim.wasm`).
//! - Call `sim_init(seed)` once, build the level with the game's own exports,
//!   then each frame: the game's input export, `sim_advance(dt)`, read
//!   buffers, `sim_clear_frame()`.
//! - `buf_<name>()` returns a pointer into wasm memory, `buf_<name>_count()`
//!   the number of records and `buf_<name>_stride()` the floats per record.
//!   Pointers stay valid until the next call that mutates the world, but the
//!   memory can grow and detach old JS views: re-create typed-array views from
//!   `memory.buffer` on every access instead of caching them.

pub mod abi;
pub mod clock;
pub mod events;
pub mod interp;
pub mod math;
mod params;

pub use abi::{Sim, Slot};

/// Version of the engine's own exports (`export_engine_abi!`). Bump it when
/// an engine export, the event stride or the lifecycle meaning changes;
/// `src/wasm.ts` carries the same number and checks it at boot.
pub const ENGINE_ABI_VERSION: u32 = 1;
